/**
 * graphBuilder.js
 *
 * Builds an in-memory graph from PostgreSQL using the schema
 * discovered by seed.js (data/discovered_schema.json).
 *
 * Key change from v1: ALL column names, FK keys, and edge
 * definitions are read from discovered_schema.json at runtime —
 * never hardcoded — so it works regardless of what the real
 * JSONL dataset's field names are.
 */

const pool = require('../db/pg');
const fs   = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../../data/discovered_schema.json');

// Node display colors by table name (best-effort match)
const TYPE_COLOR_MAP = [
  [/customer/,        '#7c6af7'],
  [/sales_order(?!_item)/, '#4f7df3'],
  [/sales_order_item|line_item|order_item/, '#3b6fd4'],
  [/product|material/, '#a3e635'],
  [/plant/,           '#94a3b8'],
  [/address/,         '#64748b'],
  [/deliver/,         '#2dd4bf'],
  [/billing|invoice/, '#f59e0b'],
  [/journal|accounting|bkpf|bseg/, '#f97316'],
  [/payment/,         '#34d399'],
];

function getNodeColor(tableName) {
  const t = tableName.toLowerCase();
  for (const [pattern, color] of TYPE_COLOR_MAP) {
    if (pattern.test(t)) return color;
  }
  return '#888780';
}

// How many nodes to load per table (keeps graph readable)
const NODE_LIMIT = 150;

let cachedGraph = null;
let lastBuilt   = null;

// ─── Load discovered schema ───────────────────────────────────────────────────

function loadDiscoveredSchema() {
  try {
    if (fs.existsSync(SCHEMA_PATH)) {
      return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('⚠️  Could not read discovered_schema.json:', e.message);
  }
  return null;
}

// ─── Build graph ──────────────────────────────────────────────────────────────

async function buildGraph() {
  console.log('🔨  Building in-memory graph...');
  const start = Date.now();

  const discovered = loadDiscoveredSchema();

  // ── 1. Determine which tables to load ───────────────────────────────────
  let tableMetas; // { [tableName]: { pk, labelCol, columns } }
  let edgeDefs;   // [ { from, to, fromKey, toKey, label } ]

  if (discovered) {
    const { _edges, ...tables } = discovered;
    tableMetas = tables;
    edgeDefs   = _edges || [];
    console.log(`  Using discovered schema: ${Object.keys(tableMetas).length} tables, ${edgeDefs.length} edges`);
  } else {
    // Last-resort: introspect live DB
    console.log('  No discovered_schema.json — introspecting DB live...');
    tableMetas = await introspectLive();
    edgeDefs   = [];
  }

  // ── 2. Load nodes from each table ───────────────────────────────────────
  const nodeMap      = new Map();   // id (string) → node object
  const nodesByTable = {};          // tableName → array of raw rows

  for (const [tableName, meta] of Object.entries(tableMetas)) {
    const pkCol    = meta.pk       || meta.columns?.[0];
    const labelCol = meta.labelCol || pkCol;
    if (!pkCol) continue;

    const selectCols = buildSelectCols(meta.columns || [], pkCol, labelCol);

    try {
      const { rows } = await pool.query(
        `SELECT ${selectCols} FROM "${tableName}" LIMIT $1`, [NODE_LIMIT]
      );

      nodesByTable[tableName] = rows;

      for (const row of rows) {
        const id = String(row.__pk ?? row[pkCol] ?? '');
        if (!id) continue;

        nodeMap.set(id, {
          ...row,
          id,
          label:       String(row.__label ?? row[labelCol] ?? id).slice(0, 60),
          nodeType:    tableName,
          color:       getNodeColor(tableName),
          connections: 0,
        });
      }
      console.log(`  ✓ ${tableName}: ${rows.length} nodes (pk="${pkCol}")`);
    } catch (e) {
      console.warn(`  ⚠️  Could not load ${tableName}: ${e.message}`);
    }
  }

  // ── 3. Build edges ───────────────────────────────────────────────────────
  const edges  = [];
  const edgeSet = new Set();

  for (const def of edgeDefs) {
    const sourceRows = nodesByTable[def.from] || [];
    const targetRows = nodesByTable[def.to]   || [];
    if (!sourceRows.length || !targetRows.length) continue;

    // Build lookup: FK value → target node id
    const targetMeta  = tableMetas[def.to] || {};
    const targetPk    = targetMeta.pk || def.toKey;
    const targetLookup = new Map();

    for (const row of targetRows) {
      const pkVal  = String(row.__pk ?? row[targetPk] ?? '');
      const fkVal  = String(row[def.toKey] ?? row.__pk ?? '');
      // Allow lookup by both the PK and the FK field value
      if (pkVal)  targetLookup.set(pkVal, pkVal);
      if (fkVal !== pkVal) targetLookup.set(fkVal, pkVal);
    }

    let edgeCount = 0;
    for (const src of sourceRows) {
      const srcId  = String(src.__pk ?? src[tableMetas[def.from]?.pk || def.fromKey] ?? '');
      const fkVal  = String(src[def.fromKey] ?? '');
      if (!fkVal || fkVal === 'null') continue;

      const tgtId = targetLookup.get(fkVal);
      if (!tgtId) continue;
      if (!nodeMap.has(srcId) || !nodeMap.has(tgtId)) continue;
      if (srcId === tgtId) continue;

      const edgeKey = `${srcId}||${tgtId}||${def.label}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      edges.push({
        id:         edgeKey,
        source:     srcId,
        target:     tgtId,
        label:      def.label,
        sourceType: def.from,
        targetType: def.to,
      });
      edgeCount++;

      nodeMap.get(srcId).connections++;
      nodeMap.get(tgtId).connections++;
    }
    if (edgeCount > 0) {
      console.log(`  ✓ edge [${def.label}] ${def.from}→${def.to}: ${edgeCount}`);
    }
  }

  const nodes   = Array.from(nodeMap.values());
  const elapsed = Date.now() - start;

  if (edges.length === 0) {
    console.warn('⚠️  Zero edges resolved. Run `node db/seed.js` again with your data files.');
    console.warn('    If you already did, check that discovered_schema.json exists in /data/');
  }

  cachedGraph = { nodes, edges };
  lastBuilt   = new Date().toISOString();

  console.log(`✅  Graph: ${nodes.length} nodes, ${edges.length} edges (${elapsed}ms)`);
  return cachedGraph;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSelectCols(columns, pkCol, labelCol) {
  // Always alias pk → __pk and label → __label for uniform access
  const parts = [];
  const added = new Set();

  if (pkCol) {
    parts.push(`"${pkCol}" AS __pk`);
    added.add(pkCol);
  }
  if (labelCol && labelCol !== pkCol) {
    parts.push(`"${labelCol}" AS __label`);
    added.add(labelCol);
  }

  // Add remaining columns (up to 15 total for perf)
  for (const col of (columns || [])) {
    if (added.has(col)) continue;
    if (parts.length >= 15) break;
    parts.push(`"${col}"`);
    added.add(col);
  }
  return parts.join(', ');
}

async function introspectLive() {
  const metas = {};
  try {
    const { rows: tbls } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`
    );
    for (const { tablename } of tbls) {
      const { rows: cols } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position`, [tablename]
      );
      const colNames = cols.map(r => r.column_name);
      metas[tablename] = {
        columns:  colNames,
        pk:       colNames[0],
        labelCol: colNames.find(c => /name|description|label/i.test(c)) || colNames[0],
      };
    }
  } catch (e) {
    console.error('Live introspection failed:', e.message);
  }
  return metas;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getGraph() { return cachedGraph; }

function getGraphMeta() {
  if (!cachedGraph) return null;
  const typeCounts = {};
  for (const n of cachedGraph.nodes) {
    typeCounts[n.nodeType] = (typeCounts[n.nodeType] || 0) + 1;
  }
  return {
    nodeCount:  cachedGraph.nodes.length,
    edgeCount:  cachedGraph.edges.length,
    typeCounts,
    lastBuilt,
  };
}

async function getNodeWithNeighbors(nodeId) {
  if (!cachedGraph) return null;
  const node = cachedGraph.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const neighborEdges = cachedGraph.edges.filter(
    e => e.source === nodeId || e.target === nodeId
  );
  const neighborIds = new Set(
    neighborEdges.flatMap(e => [e.source, e.target])
  );
  neighborIds.delete(nodeId);

  const neighbors = Array.from(neighborIds)
    .map(id => cachedGraph.nodes.find(n => n.id === id))
    .filter(Boolean);

  return { node, neighbors, edges: neighborEdges };
}

module.exports = { buildGraph, getGraph, getGraphMeta, getNodeWithNeighbors };
