/**
 * schemaRegistry.js
 *
 * Reads the schema discovered at seed time (data/discovered_schema.json)
 * and builds the LLM prompt context from ACTUAL column names.
 *
 * Falls back to static schema if discovered_schema.json is not present.
 */

const fs   = require('fs');
const path = require('path');
const pool = require('../db/pg');

const SCHEMA_PATH = path.join(__dirname, '../../data/discovered_schema.json');

// ─── Load discovered schema ───────────────────────────────────────────────────

function loadDiscovered() {
  try {
    if (fs.existsSync(SCHEMA_PATH)) {
      return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('schemaRegistry: could not read discovered_schema.json:', e.message);
  }
  return null;
}

// ─── Build LLM prompt context ─────────────────────────────────────────────────

function buildPromptContext() {
  const discovered = loadDiscovered();
  if (!discovered) return buildStaticContext();

  let ctx = 'DATABASE SCHEMA (PostgreSQL):\n';
  ctx += '===============================\n\n';

  for (const [table, meta] of Object.entries(discovered)) {
    if (table.startsWith('_')) continue;
    ctx += `TABLE: ${table}\n`;
    if (meta.columns?.length) {
      for (const col of meta.columns) {
        let line = `  ${col}  TEXT`;
        // Annotate PK
        if (col === meta.pk) line += '  [PRIMARY KEY]';
        // Annotate FK from edge definitions
        const fkEdge = (discovered._edges || []).find(
          e => e.from === table && e.fromKey === col
        );
        if (fkEdge) line += `  [FK → ${fkEdge.to}.${fkEdge.toKey}]`;
        ctx += line + '\n';
      }
    }
    ctx += '\n';
  }

  // Add relationships summary
  const edges = discovered._edges || [];
  if (edges.length) {
    ctx += 'RELATIONSHIPS (verified FK joins):\n';
    for (const e of edges) {
      ctx += `  ${e.from}.${e.fromKey} → ${e.to}.${e.toKey}  (${e.label})\n`;
    }
    ctx += '\n';
  }

  // Sample values to help LLM understand data shapes
  ctx += 'SAMPLE VALUES (to guide query writing):\n';
  for (const [table, meta] of Object.entries(discovered)) {
    if (table.startsWith('_') || !meta.sample) continue;
    const sample = meta.sample;
    const entries = Object.entries(sample).slice(0, 5)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    ctx += `  ${table}: { ${entries} }\n`;
  }

  return ctx;
}

// ─── Static fallback ─────────────────────────────────────────────────────────

function buildStaticContext() {
  return `DATABASE SCHEMA (PostgreSQL):
TABLE: customers       -- customer_id (PK), name, segment, region, country
TABLE: products        -- material_id (PK), description, category, unit, unit_price
TABLE: plants          -- plant_id (PK), name, location, country
TABLE: addresses       -- address_id (PK), customer_id (FK→customers), street, city, country
TABLE: sales_orders    -- order_id (PK), customer_id (FK→customers), order_date, status, total_amount, currency
TABLE: sales_order_items -- item_id (PK), order_id (FK→sales_orders), material_id (FK→products), quantity, net_value, plant_id
TABLE: deliveries      -- delivery_id (PK), order_id (FK→sales_orders), customer_id, plant_id, ship_date, delivery_status
TABLE: billing_docs    -- billing_id (PK), delivery_id (FK→deliveries), order_id, billing_date, net_value, billing_type
TABLE: journal_entries -- journal_id (PK), billing_id (FK→billing_docs), gl_account, amount, posting_date
TABLE: payments        -- payment_id (PK), billing_id (FK→billing_docs), customer_id, amount, payment_method

RELATIONSHIPS:
  sales_orders.customer_id → customers.customer_id
  sales_order_items.order_id → sales_orders.order_id
  sales_order_items.material_id → products.material_id
  deliveries.order_id → sales_orders.order_id
  billing_docs.delivery_id → deliveries.delivery_id
  journal_entries.billing_id → billing_docs.billing_id
  payments.billing_id → billing_docs.billing_id
`;
}

// ─── Get table list (for /api/schema endpoint) ────────────────────────────────

function getTableList() {
  const discovered = loadDiscovered();
  if (!discovered) return null;
  const { _edges, ...tables } = discovered;
  return { tables, edges: _edges || [] };
}

// ─── Live schema from DB (used for diagnostics) ───────────────────────────────

async function getLiveSchema() {
  const { rows: tbls } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  const result = {};
  for (const { tablename } of tbls) {
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position`, [tablename]
    );
    const { rows: cnt } = await pool.query(`SELECT COUNT(*) FROM "${tablename}"`);
    result[tablename] = {
      columns: cols.map(r => ({ name: r.column_name, type: r.data_type })),
      rowCount: parseInt(cnt[0].count),
    };
  }
  return result;
}

// ─── Edge definitions (for graphBuilder compatibility) ────────────────────────

function getEdgeDefinitions() {
  const discovered = loadDiscovered();
  if (discovered?._edges?.length) return discovered._edges;
  // Static fallback
  return [
    { from:'sales_orders',      to:'customers',         fromKey:'customer_id',  toKey:'customer_id',  label:'PLACED_BY' },
    { from:'sales_order_items', to:'sales_orders',      fromKey:'order_id',     toKey:'order_id',     label:'BELONGS_TO' },
    { from:'sales_order_items', to:'products',          fromKey:'material_id',  toKey:'material_id',  label:'REFS_MATERIAL' },
    { from:'deliveries',        to:'sales_orders',      fromKey:'order_id',     toKey:'order_id',     label:'SHIPS_VIA' },
    { from:'deliveries',        to:'plants',            fromKey:'plant_id',     toKey:'plant_id',     label:'AT_PLANT' },
    { from:'billing_docs',      to:'deliveries',        fromKey:'delivery_id',  toKey:'delivery_id',  label:'BILLED_AS' },
    { from:'journal_entries',   to:'billing_docs',      fromKey:'billing_id',   toKey:'billing_id',   label:'POSTS_TO' },
    { from:'payments',          to:'billing_docs',      fromKey:'billing_id',   toKey:'billing_id',   label:'SETTLES' },
    { from:'addresses',         to:'customers',         fromKey:'customer_id',  toKey:'customer_id',  label:'BELONGS_TO' },
  ];
}

module.exports = { buildPromptContext, getTableList, getLiveSchema, getEdgeDefinitions };
