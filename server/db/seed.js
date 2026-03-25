/**
 * seed.js — Handles JSONL datasets with auto-discovery of column names.
 *
 * Supports:
 *   1. JSONL files in /data/*.jsonl  (real dataset)
 *   2. JSON files in /data/*.json
 *   3. CSV files in /data/*.csv
 *   4. Synthetic fallback if no data files found
 *
 * After loading, runs schema introspection and writes
 * /data/discovered_schema.json so graphBuilder can
 * resolve edges against actual column names.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'erp_graph',
});

// ─── File discovery ──────────────────────────────────────────────────────────

function findDataFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => /\.(jsonl|json|csv)$/i.test(f) && f !== 'discovered_schema.json')
    .map(f => ({
      name: f,
      path: path.join(DATA_DIR, f),
      ext:  path.extname(f).toLowerCase(),
    }));
}

function loadJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function loadJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(raw) ? raw : [raw];
}

function loadCsv(filePath) {
  const { parse } = require('csv-parse/sync');
  return parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true,
  });
}

function loadFile(file) {
  try {
    if (file.ext === '.jsonl') return loadJsonl(file.path);
    if (file.ext === '.json')  return loadJson(file.path);
    if (file.ext === '.csv')   return loadCsv(file.path);
  } catch (e) {
    console.warn(`  ⚠️  Could not load ${file.name}: ${e.message}`);
  }
  return [];
}

// ─── Table name inference ────────────────────────────────────────────────────

const TABLE_ALIASES = {
  'sales_order':'sales_orders','salesorder':'sales_orders',
  'purchase_order':'sales_orders','purchaseorder':'sales_orders',
  'orders':'sales_orders','order':'sales_orders','vbak':'sales_orders',
  'sales_order_item':'sales_order_items','order_item':'sales_order_items',
  'orderitem':'sales_order_items','order_items':'sales_order_items',
  'vbap':'sales_order_items','line_item':'sales_order_items','line_items':'sales_order_items',
  'delivery':'deliveries','outbound_delivery':'deliveries',
  'likp':'deliveries','lips':'deliveries',
  'billing':'billing_docs','billing_doc':'billing_docs',
  'billing_document':'billing_docs','invoice':'billing_docs',
  'vbrk':'billing_docs','vbrp':'billing_docs','invoices':'billing_docs',
  'journal':'journal_entries','journal_entry':'journal_entries',
  'accounting':'journal_entries','bkpf':'journal_entries','bseg':'journal_entries',
  'gl_entry':'journal_entries','fi_document':'journal_entries','accounting_document':'journal_entries',
  'payment':'payments',
  'customer':'customers','kna1':'customers',
  'product':'products','material':'products','materials':'products','mara':'products',
  'plant':'plants','t001w':'plants',
  'address':'addresses',
};

function inferTableName(filename) {
  const base = path.basename(filename, path.extname(filename))
    .toLowerCase().replace(/[-\s]/g, '_');
  return TABLE_ALIASES[base] || base;
}

// ─── Column sanitisation ─────────────────────────────────────────────────────

function sanitizeColName(col) {
  return col.toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .slice(0, 63);
}

function sanitizeValue(val) {
  if (val === '' || val === 'null' || val === 'NULL' || val === undefined) return null;
  return val;
}

// ─── Dynamic table creation ──────────────────────────────────────────────────

async function createDynamicTable(client, tableName, rows) {
  if (!rows.length) return [];

  // Collect all unique keys across sample rows (handles sparse JSONL)
  const allKeys = new Set();
  rows.slice(0, 300).forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));

  const cols = [];
  const seenSanitized = new Set();
  for (const k of allKeys) {
    const s = sanitizeColName(k);
    if (!s || s === '_' || seenSanitized.has(s)) continue;
    seenSanitized.add(s);
    cols.push({ original: k, sanitized: s });
  }

  // Infer column types from first non-null values
  const colTypes = {};
  for (const col of cols) {
    let val = null;
    for (const row of rows.slice(0, 100)) {
      const v = row[col.original];
      if (v !== null && v !== undefined && v !== '') { val = v; break; }
    }
    if (val === null) { colTypes[col.sanitized] = 'TEXT'; continue; }
    if (typeof val === 'number') {
      colTypes[col.sanitized] = Number.isInteger(val) ? 'BIGINT' : 'NUMERIC';
    } else if (typeof val === 'boolean') {
      colTypes[col.sanitized] = 'BOOLEAN';
    } else if (/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(String(val))) {
      colTypes[col.sanitized] = 'TIMESTAMP';
    } else {
      colTypes[col.sanitized] = 'TEXT';
    }
  }

  const colDefs = cols.map(c => `"${c.sanitized}" ${colTypes[c.sanitized]}`).join(',\n  ');
  await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
  await client.query(`CREATE TABLE "${tableName}" (\n  ${colDefs}\n)`);

  // Index likely FK / ID columns immediately
  for (const col of cols) {
    if (/id$|_no$|_num$/i.test(col.sanitized)) {
      try {
        await client.query(
          `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${col.sanitized}" ON "${tableName}" ("${col.sanitized}")`
        );
      } catch (_) {}
    }
  }

  return cols;
}

// ─── Bulk insert ─────────────────────────────────────────────────────────────

async function bulkInsert(client, tableName, rows, colMap) {
  if (!rows.length || !colMap.length) return 0;
  const BATCH = 500;
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const colNames = colMap.map(c => `"${c.sanitized}"`).join(', ');
    const values = [];
    const placeholders = batch.map((row, ri) => {
      const rowPlaceholders = colMap.map((c, ci) => {
        values.push(sanitizeValue(row[c.original]));
        return `$${ri * colMap.length + ci + 1}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    }).join(',\n');

    try {
      await client.query(
        `INSERT INTO "${tableName}" (${colNames}) VALUES ${placeholders}`,
        values
      );
      total += batch.length;
    } catch {
      // Row-by-row fallback
      for (const row of batch) {
        const rVals = colMap.map(c => sanitizeValue(row[c.original]));
        const rPh   = colMap.map((_, ci) => `$${ci + 1}`).join(', ');
        try {
          await client.query(
            `INSERT INTO "${tableName}" (${colNames}) VALUES (${rPh})`, rVals
          );
          total++;
        } catch (_) {}
      }
    }
  }
  return total;
}

// ─── FK / Edge discovery ─────────────────────────────────────────────────────

// Column name → [candidate target table hint, target col name hint]
const FK_HINTS = [
  [/^order_id$|^vbeln$|^sales_order_id$|^so_number$/i,      'sales_orders',      /^order_id$|^vbeln$|^id$/i],
  [/^customer_id$|^kunnr$|^sold_to$|^customer_no$/i,        'customers',         /^customer_id$|^kunnr$|^id$/i],
  [/^material_id$|^matnr$|^material_no$|^product_id$/i,     'products',          /^material_id$|^matnr$|^id$/i],
  [/^plant_id$|^werks$|^plant$|^plant_code$/i,              'plants',            /^plant_id$|^werks$|^id$/i],
  [/^delivery_id$|^vbeln_vl$|^delivery_no$|^deliv_no$/i,    'deliveries',        /^delivery_id$|^vbeln_vl$|^id$/i],
  [/^billing_id$|^vbeln_vf$|^billing_doc$|^invoice_id$/i,   'billing_docs',      /^billing_id$|^vbeln_vf$|^id$/i],
  [/^item_id$|^posnr$|^line_item_id$|^item_no$/i,           'sales_order_items', /^item_id$|^posnr$|^id$/i],
  [/^journal_id$|^belnr$|^accounting_doc_id$/i,             'journal_entries',   /^journal_id$|^belnr$|^id$/i],
];

function inferEdgeLabel(fromTable, toTable) {
  const map = {
    'sales_orders|customers':          'PLACED_BY',
    'sales_order_items|sales_orders':  'HAS_ITEM',
    'sales_order_items|products':      'REFS_MATERIAL',
    'deliveries|sales_orders':         'SHIPS_VIA',
    'deliveries|customers':            'DELIVERS_TO',
    'deliveries|plants':               'AT_PLANT',
    'billing_docs|deliveries':         'BILLED_AS',
    'billing_docs|sales_orders':       'FOR_ORDER',
    'billing_docs|customers':          'BILLED_TO',
    'journal_entries|billing_docs':    'POSTS_TO',
    'payments|billing_docs':           'SETTLES',
    'payments|customers':              'PAID_BY',
    'addresses|customers':             'BELONGS_TO',
    'sales_order_items|deliveries':    'DELIVERED_IN',
  };
  return map[`${fromTable}|${toTable}`] || `LINKS_TO`;
}

async function discoverEdges(client, loadedTables) {
  const edges = [];
  const edgeSet = new Set();

  // Get actual columns for each table
  const tableColumns = {};
  for (const t of loadedTables) {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position`, [t]
    );
    tableColumns[t] = rows.map(r => r.column_name);
  }

  // For each table, check each column against FK hints
  for (const sourceTable of loadedTables) {
    for (const col of tableColumns[sourceTable] || []) {
      for (const [colPattern, targetHint, targetColPattern] of FK_HINTS) {
        if (!colPattern.test(col)) continue;

        // Find target table — exact match or fuzzy
        const targetTable = loadedTables.find(t =>
          t === targetHint ||
          t.replace(/_/g, '') === targetHint.replace(/_/g, '') ||
          (targetHint.endsWith('s') && t === targetHint.slice(0, -1)) ||
          t.includes(targetHint.replace(/s$/, '').replace(/_/g, ''))
        );
        if (!targetTable || targetTable === sourceTable) continue;

        const targetCols = tableColumns[targetTable] || [];
        const targetCol  = targetCols.find(c => targetColPattern.test(c)) || targetCols[0];
        if (!targetCol) continue;

        const edgeKey = `${sourceTable}|${targetTable}|${col}`;
        if (edgeSet.has(edgeKey)) continue;

        // Spot-check: do values actually join?
        try {
          const { rows: check } = await client.query(`
            SELECT COUNT(*) AS n FROM (
              SELECT src."${col}" FROM "${sourceTable}" src
              WHERE src."${col}" IS NOT NULL LIMIT 20
            ) s
            INNER JOIN "${targetTable}" t ON t."${targetCol}" = s."${col}"
          `);
          if (parseInt(check[0].n) === 0) continue;
        } catch { continue; }

        edgeSet.add(edgeKey);
        edges.push({
          from:     sourceTable,
          to:       targetTable,
          fromKey:  col,
          toKey:    targetCol,
          label:    inferEdgeLabel(sourceTable, targetTable),
          verified: true,
        });
        break; // one FK hint match per column is enough
      }
    }
  }

  return edges;
}

async function discoverSchema(client, loadedTables) {
  console.log('\n🔍  Discovering schema and FK relationships...');
  const schema = {};

  for (const tableName of loadedTables) {
    const { rows: colRows } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position`, [tableName]
    );
    const cols = colRows.map(r => r.column_name);
    const labelCol = cols.find(c => /name|description|title|label/i.test(c))
      || cols.find(c => /id$/i.test(c))
      || cols[0];
    const pkCol = cols.find(c => c === `${tableName.replace(/s$/, '')}_id`)
      || cols.find(c => /^id$/.test(c))
      || cols[0];

    let sample = {};
    try {
      const { rows } = await client.query(`SELECT * FROM "${tableName}" LIMIT 1`);
      if (rows.length) sample = rows[0];
    } catch (_) {}

    schema[tableName] = { columns: cols, pk: pkCol, labelCol, sample };
  }

  const edges = await discoverEdges(client, loadedTables);
  schema._edges = edges;

  console.log(`  Found ${edges.length} verified FK edges:`);
  edges.forEach(e => console.log(`    ✓ ${e.from}.${e.fromKey} → ${e.to}.${e.toKey}  [${e.label}]`));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'discovered_schema.json'),
    JSON.stringify(schema, null, 2)
  );
  console.log(`  📄 Schema written → data/discovered_schema.json`);
  return schema;
}

// ─── Synthetic fallback ───────────────────────────────────────────────────────

async function seedSynthetic(client) {
  console.log('🔧  Generating synthetic ERP data...');
  const rnd    = arr => arr[Math.floor(Math.random() * arr.length)];
  const rndInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const pad    = (n, l=8) => String(n).padStart(l, '0');

  await client.query(`
    DROP TABLE IF EXISTS payments, journal_entries, billing_docs,
      deliveries, sales_order_items, sales_orders,
      addresses, products, plants, customers CASCADE;

    CREATE TABLE customers (customer_id TEXT PRIMARY KEY, name TEXT, segment TEXT, country TEXT);
    CREATE TABLE products  (material_id TEXT PRIMARY KEY, description TEXT, category TEXT, unit_price NUMERIC);
    CREATE TABLE plants    (plant_id TEXT PRIMARY KEY, name TEXT, location TEXT);
    CREATE TABLE addresses (address_id TEXT PRIMARY KEY, customer_id TEXT, city TEXT, country TEXT);
    CREATE TABLE sales_orders (order_id TEXT PRIMARY KEY, customer_id TEXT, order_date DATE, status TEXT, total_amount NUMERIC);
    CREATE TABLE sales_order_items (item_id TEXT PRIMARY KEY, order_id TEXT, material_id TEXT, quantity NUMERIC, net_value NUMERIC, plant_id TEXT);
    CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, order_id TEXT, customer_id TEXT, plant_id TEXT, delivery_status TEXT);
    CREATE TABLE billing_docs (billing_id TEXT PRIMARY KEY, delivery_id TEXT, order_id TEXT, billing_date DATE, net_value NUMERIC);
    CREATE TABLE journal_entries (journal_id TEXT PRIMARY KEY, billing_id TEXT, amount NUMERIC, posting_date DATE);
    CREATE TABLE payments (payment_id TEXT PRIMARY KEY, billing_id TEXT, customer_id TEXT, amount NUMERIC, payment_method TEXT);
  `);

  const custs = Array.from({length:50},(_,i)=>({
    id:`CUST${pad(i+1,6)}`, name:`Customer ${i+1} Ltd`,
    seg:rnd(['Enterprise','SMB','Retail']), country:'IN'
  }));
  const prods = Array.from({length:30},(_,i)=>({
    id:`MAT${pad(i+1,6)}`,
    desc:`Product ${String.fromCharCode(65+i%26)}${i+1}`,
    cat:rnd(['Electronics','Raw Materials','Finished Goods']),
    price:rndInt(500,20000)
  }));
  const plants = [
    {id:'P001',name:'Mumbai Plant',loc:'Mumbai'},
    {id:'P002',name:'Delhi Hub',loc:'Delhi'},
    {id:'P003',name:'Bangalore WH',loc:'Bangalore'},
  ];

  for (const c of custs)
    await client.query('INSERT INTO customers VALUES($1,$2,$3,$4)',[c.id,c.name,c.seg,c.country]);
  for (const p of prods)
    await client.query('INSERT INTO products VALUES($1,$2,$3,$4)',[p.id,p.desc,p.cat,p.price]);
  for (const p of plants)
    await client.query('INSERT INTO plants VALUES($1,$2,$3)',[p.id,p.name,p.loc]);
  for (const c of custs)
    await client.query('INSERT INTO addresses VALUES($1,$2,$3,$4)',
      [`ADDR${c.id}`,c.id,rnd(['Mumbai','Delhi','Chennai']),c.country]);

  const orders = [];
  for (let i=0;i<150;i++){
    const c=rnd(custs);
    const o={id:`SO${pad(i+1)}`,cid:c.id,status:rnd(['OPEN','COMPLETED','COMPLETED','IN_PROCESS'])};
    orders.push(o);
    await client.query('INSERT INTO sales_orders VALUES($1,$2,$3,$4,$5)',
      [o.id,o.cid,'2024-06-01',o.status,rndInt(5000,200000)]);
  }
  for (let i=0;i<300;i++){
    const o=rnd(orders); const p=rnd(prods); const qty=rndInt(1,50);
    await client.query('INSERT INTO sales_order_items VALUES($1,$2,$3,$4,$5,$6)',
      [`${o.id}-${pad(i+1,3)}`,o.id,p.id,qty,qty*p.price,rnd(plants).id]);
  }
  const dels=[];
  for (const o of orders.filter(x=>x.status!=='OPEN').slice(0,100)){
    const d={id:`DEL${o.id.replace('SO','')}`,oid:o.id,cid:o.cid,pid:rnd(plants).id,
      status:rnd(['COMPLETED','COMPLETED','PENDING'])};
    dels.push(d);
    await client.query('INSERT INTO deliveries VALUES($1,$2,$3,$4,$5)',
      [d.id,d.oid,d.cid,d.pid,d.status]);
  }
  let bn=1;
  for (const d of dels.filter(x=>x.status==='COMPLETED').slice(0,70)){
    const bid=`BILL${pad(bn++)}`;
    await client.query('INSERT INTO billing_docs VALUES($1,$2,$3,$4,$5)',
      [bid,d.id,d.oid,'2024-09-01',rndInt(10000,500000)]);
    await client.query('INSERT INTO journal_entries VALUES($1,$2,$3,$4)',
      [`JE${pad(bn)}`,bid,rndInt(10000,500000),'2024-09-05']);
    if (Math.random()>0.2)
      await client.query('INSERT INTO payments VALUES($1,$2,$3,$4,$5)',
        [`PAY${pad(bn)}`,bid,d.cid,rndInt(10000,500000),rnd(['NEFT','RTGS'])]);
  }
  console.log(`✅  Synthetic seed complete (150 orders, 70 billings)`);

  // Write synthetic schema so graphBuilder works identically
  const schema = {
    customers:         { columns:['customer_id','name','segment','country'], pk:'customer_id', labelCol:'name' },
    products:          { columns:['material_id','description','category','unit_price'], pk:'material_id', labelCol:'description' },
    plants:            { columns:['plant_id','name','location'], pk:'plant_id', labelCol:'name' },
    addresses:         { columns:['address_id','customer_id','city','country'], pk:'address_id', labelCol:'city' },
    sales_orders:      { columns:['order_id','customer_id','order_date','status','total_amount'], pk:'order_id', labelCol:'order_id' },
    sales_order_items: { columns:['item_id','order_id','material_id','quantity','net_value','plant_id'], pk:'item_id', labelCol:'item_id' },
    deliveries:        { columns:['delivery_id','order_id','customer_id','plant_id','delivery_status'], pk:'delivery_id', labelCol:'delivery_id' },
    billing_docs:      { columns:['billing_id','delivery_id','order_id','billing_date','net_value'], pk:'billing_id', labelCol:'billing_id' },
    journal_entries:   { columns:['journal_id','billing_id','amount','posting_date'], pk:'journal_id', labelCol:'journal_id' },
    payments:          { columns:['payment_id','billing_id','customer_id','amount','payment_method'], pk:'payment_id', labelCol:'payment_id' },
    _edges: [
      { from:'sales_orders',      to:'customers',         fromKey:'customer_id',  toKey:'customer_id',  label:'PLACED_BY',     verified:true },
      { from:'sales_order_items', to:'sales_orders',      fromKey:'order_id',     toKey:'order_id',     label:'BELONGS_TO',    verified:true },
      { from:'sales_order_items', to:'products',          fromKey:'material_id',  toKey:'material_id',  label:'REFS_MATERIAL', verified:true },
      { from:'sales_order_items', to:'plants',            fromKey:'plant_id',     toKey:'plant_id',     label:'SOURCED_FROM',  verified:true },
      { from:'deliveries',        to:'sales_orders',      fromKey:'order_id',     toKey:'order_id',     label:'SHIPS_VIA',     verified:true },
      { from:'deliveries',        to:'customers',         fromKey:'customer_id',  toKey:'customer_id',  label:'DELIVERS_TO',   verified:true },
      { from:'deliveries',        to:'plants',            fromKey:'plant_id',     toKey:'plant_id',     label:'AT_PLANT',      verified:true },
      { from:'billing_docs',      to:'deliveries',        fromKey:'delivery_id',  toKey:'delivery_id',  label:'BILLED_AS',     verified:true },
      { from:'billing_docs',      to:'sales_orders',      fromKey:'order_id',     toKey:'order_id',     label:'FOR_ORDER',     verified:true },
      { from:'journal_entries',   to:'billing_docs',      fromKey:'billing_id',   toKey:'billing_id',   label:'POSTS_TO',      verified:true },
      { from:'payments',          to:'billing_docs',      fromKey:'billing_id',   toKey:'billing_id',   label:'SETTLES',       verified:true },
      { from:'addresses',         to:'customers',         fromKey:'customer_id',  toKey:'customer_id',  label:'BELONGS_TO',    verified:true },
    ]
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR,'discovered_schema.json'), JSON.stringify(schema,null,2));
  return schema;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const files = findDataFiles();
  const client = await pool.connect();

  try {
    if (!files.length) {
      await seedSynthetic(client);
    } else {
      console.log(`📂  Found ${files.length} file(s): ${files.map(f=>f.name).join(', ')}`);

      const loadedTables = [];
      for (const file of files) {
        const tableName = inferTableName(file.name);
        console.log(`\n  ▶ ${file.name} → "${tableName}"`);
        const rows = loadFile(file);
        if (!rows.length) { console.log('    (empty, skipped)'); continue; }

        const colMap   = await createDynamicTable(client, tableName, rows);
        const inserted = await bulkInsert(client, tableName, rows, colMap);
        console.log(`    ✓ ${inserted}/${rows.length} rows, ${colMap.length} columns`);
        loadedTables.push(tableName);
      }

      await discoverSchema(client, loadedTables);
    }

    // Final row counts
    const { rows: tbls } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    console.log('\n📊  Final counts:');
    for (const { tablename } of tbls) {
      const { rows } = await client.query(`SELECT COUNT(*) FROM "${tablename}"`);
      console.log(`    ${tablename}: ${rows[0].count}`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('❌  Seed failed:', err); process.exit(1); });
