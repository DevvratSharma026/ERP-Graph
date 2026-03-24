# ERP Graph — Graph-Based Data Modeling & Query System

> Forward Deployed Engineer take-home — Dodge AI

A full-stack system that unifies fragmented ERP data (Orders, Deliveries, Billing, Payments, Customers, Products) into an interactive graph with an LLM-powered natural language query interface.

---

## Live Demo

> [Your deployment URL here]

## Repository

> [Your GitHub URL here]

---

## Architecture Overview

```
┌──────────────────────────────────────────────┐
│                React Client                   │
│  GraphCanvas (force-graph) │ ChatPanel        │
│  NodeInspector             │ (streaming SSE)  │
└────────────────┬───────────┴──────────────────┘
                 │ HTTP / SSE
┌────────────────▼───────────────────────────────┐
│              Express API (Node.js)              │
│  /api/graph  │  /api/chat  │  /api/schema       │
├──────────────┴──────────────┴───────────────────┤
│         Core Services                           │
│  graphBuilder  │  llmPipeline  │  guardrail     │
│  schemaRegistry│  llmClient    │  sqlExecutor   │
└────────────────┬────────────────────────────────┘
                 │
         ┌───────┴────────┐
         │  PostgreSQL    │   Groq / Gemini
         │  (10 tables)   │   (free tier LLM)
         └────────────────┘
```

---

## Database Decision: PostgreSQL

**Why PostgreSQL over MongoDB or Neo4j:**

The ERP dataset is inherently relational — sales orders have items, items reference materials, deliveries tie to plants. The core feature is NL→SQL translation, and SQL is the natural target language when the data lives in typed, normalized tables.

**Tradeoffs considered:**

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **PostgreSQL** | Perfect SQL target for LLM, strong JOINs, typed schema, free | No native graph traversal | ✅ Primary store |
| MongoDB | Flexible schema, easy JSON storage | No JOINs = complex aggregation pipelines (harder to prompt) | ✅ Optional for chat history |
| Neo4j | Native graph traversal, Cypher queries | Overkill for structured ERP data; Cypher harder to generate from LLM | ❌ Skipped |

**Graph layer:** Built as an in-memory adjacency map populated from PostgreSQL on startup. This gives sub-millisecond reads for the visualization layer without a separate graph database.

---

## Graph Data Model

### Node Types (10)

| Node | Description | Key Fields |
|------|-------------|------------|
| `customers` | Business buyers | customer_id, name, segment, region |
| `sales_orders` | Purchase orders (SAP: VBAK) | order_id, customer_id, status, total_amount |
| `sales_order_items` | Line items (SAP: VBAP) | item_id, order_id, material_id, quantity |
| `products` | Materials catalogue | material_id, description, category |
| `deliveries` | Outbound shipments (SAP: LIKP) | delivery_id, order_id, ship_date, status |
| `billing_docs` | Invoice documents (SAP: VBRK) | billing_id, delivery_id, net_value, type |
| `journal_entries` | GL postings (SAP: BKPF) | journal_id, billing_id, gl_account, amount |
| `payments` | Settlement records | payment_id, billing_id, amount, method |
| `plants` | Warehouses/factories | plant_id, name, location |
| `addresses` | Customer ship-to addresses | address_id, customer_id, city, country |

### Edge Types (Order-to-Cash Flow)

```
Customer ──[PLACED]──────────→ SalesOrder
SalesOrder ──[HAS_ITEM]───────→ SalesOrderItem
SalesOrderItem ──[REFS_MATERIAL]→ Product
SalesOrderItem ──[SOURCED_FROM]→ Plant
SalesOrder ──[SHIPS_VIA]──────→ Delivery
Delivery ──[AT_PLANT]─────────→ Plant
Delivery ──[BILLED_AS]────────→ BillingDoc
BillingDoc ──[POSTS_TO]───────→ JournalEntry
BillingDoc ──[SETTLED_BY]─────→ Payment
Customer ──[HAS_ADDRESS]──────→ Address
Customer ──[RECEIVES]─────────→ Delivery
```

---

## LLM Prompting Strategy

### Pipeline (5 steps)

```
User Query
    │
    ▼
1. Guardrail Check (2-layer)
    ├── Layer 1: Regex pre-filter (no API call)
    └── Layer 2: LLM domain classifier
         └── OUT_OF_DOMAIN → reject with message
    │
    ▼
2. Schema Injection
    └── 10 table definitions with column types, FK relations, value notes
    │
    ▼
3. NL → SQL (LLM Pass 1)
    └── Zero-temperature, SELECT-only, with retry on error
    │
    ▼
4. SQL Safety Validation + Execution
    ├── Regex block: INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER
    ├── LIMIT enforcement
    └── node-postgres query with auto-retry on LLM-fixable errors
    │
    ▼
5. Answer Synthesis (LLM Pass 2)
    └── Data-grounded NL reply, streamed via SSE
```

### Guardrail Design

**Two-layer approach** minimises API costs and latency:

**Layer 1 — Regex (free, <1ms):**
- Rejects obvious off-topic patterns: creative writing, general knowledge, coding questions, etc.
- Fast-passes queries containing strong ERP keywords (order, invoice, delivery, etc.)

**Layer 2 — LLM Classifier (only if Layer 1 is inconclusive):**
```
System: You are a strict domain classifier...
→ Returns: { "classification": "IN_DOMAIN" | "OUT_OF_DOMAIN", "reason": "..." }
```
Fails open (LLM error → allow through) so guardrail outages don't break real queries.

**SQL safety (defense-in-depth):**
```js
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|...)\b/i
```
Applied before every execution regardless of LLM output.

### NL→SQL Prompt Design

Key design decisions:
- **Zero temperature** for deterministic SQL generation
- **Schema context** includes column types, FK relations, and value examples (e.g. `status: OPEN | IN_PROCESS | COMPLETED | CANCELLED`)
- **Common patterns** section handles the task's example queries (trace flows, broken flows, top-N by billing)
- **CANNOT_ANSWER** escape hatch prevents hallucinated SQL when the question is genuinely unanswerable
- **Auto-retry** on SQL error: LLM gets the error message and fixes its own query

---

## Folder Structure

```
erp-graph/
├── client/                        # React + Vite
│   └── src/
│       ├── components/
│       │   ├── GraphCanvas.jsx    # react-force-graph-2d + highlights
│       │   ├── NodeInspector.jsx  # sidebar with metadata + neighbours
│       │   └── ChatPanel.jsx      # streaming chat + SQL drawer + results table
│       ├── hooks/
│       │   ├── useGraphData.js    # graph fetch + highlight state
│       │   └── useChat.js         # SSE streaming + conversation history
│       └── App.jsx                # split-pane layout
│
├── server/                        # Express + Node.js
│   ├── db/
│   │   ├── pg.js                  # connection pool
│   │   └── seed.js                # schema DDL + CSV/synthetic seeder
│   ├── services/
│   │   ├── schemaRegistry.js      # table defs → prompt context + edge defs
│   │   ├── graphBuilder.js        # in-memory node/edge map from PG
│   │   ├── guardrail.js           # 2-layer domain classifier
│   │   ├── llmClient.js           # Groq / Gemini / OpenRouter adapter
│   │   └── llmPipeline.js         # full query pipeline (buffered + streaming)
│   ├── routes/
│   │   ├── graph.routes.js
│   │   ├── chat.routes.js         # SSE streaming endpoint
│   │   └── schema.routes.js
│   └── index.js
│
├── data/                          # Place real CSVs here
└── scripts/
```

---

## Setup & Running

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- A free LLM API key (Groq recommended — fastest free tier)

### 1. Clone and install

```bash
git clone <repo-url>
cd erp-graph

# Install root deps
npm install

# Install server deps
cd server && npm install

# Install client deps
cd ../client && npm install
```

### 2. Configure environment

```bash
cd server
cp .env.example .env
# Edit .env:
#   PG_DATABASE=erp_graph
#   PG_USER, PG_PASSWORD
#   LLM_PROVIDER=groq
#   LLM_API_KEY=<your groq key from console.groq.com>
```

### 3. Create database and seed

```bash
createdb erp_graph

# With synthetic data (works immediately, no CSVs needed):
cd server && node db/seed.js

# With real dataset:
# 1. Download from the provided Google Drive link
# 2. Place CSVs in /data/ directory
# 3. Run: node db/seed.js
```

### 4. Run

```bash
# From project root — starts both server (5000) and client (5173)
npm run dev
```

Open http://localhost:5173

---

## LLM Provider Configuration

| Provider | `.env` setting | Free tier |
|----------|---------------|-----------|
| **Groq** (recommended) | `LLM_PROVIDER=groq` + `LLM_MODEL=llama3-70b-8192` | 30 req/min |
| Google Gemini | `LLM_PROVIDER=gemini` + `LLM_MODEL=gemini-1.5-flash` | 15 req/min |
| OpenRouter | `LLM_PROVIDER=openrouter` | Varies by model |

---

## Example Queries (Task Brief)

All three required queries work out of the box:

**a. Products with highest billing document count:**
> "Which products are associated with the highest number of billing documents?"

**b. Full Order-to-Cash trace:**
> "Trace the full flow of billing document BILL00000001"

**c. Broken/incomplete flows:**
> "Find sales orders that were delivered but never billed"
> "Show orders that were billed without a delivery record"

---

## Bonus Features Implemented

- ✅ **Streaming responses** via SSE — answer tokens stream to UI in real time
- ✅ **Graph node highlighting** — SQL results automatically highlight referenced nodes in the graph
- ✅ **Conversation memory** — last 6 turns sent as context for follow-up questions
- ✅ **SQL drawer** — expandable SQL query display per chat message
- ✅ **Results table** — expandable data grid showing raw query results
- ✅ **Auto-retry on SQL error** — LLM self-corrects with the error message
- ✅ **Node inspector** — click any graph node to see metadata + connected neighbours

---

## AI Coding Session

AI tools used: Claude (claude.ai) for architecture design, service layer, and component scaffolding.
Session transcript included in `/ai-session-log/` directory.
