# AI Coding Session Log
**Project:** ERP Graph — Graph-Based Data Modeling & Query System
**Role Applied For:** Forward Deployed Engineer, Dodge AI
**AI Tools Used:** Claude (claude.ai) + Antigravity
**Session Format:** Conversational architecture + iterative code generation

---

## Session Overview

This document captures the full AI-assisted development session for the ERP Graph project.
The session was structured in distinct phases: architecture design, backend build,
frontend build, bug diagnosis, and fixes.

---

## Phase 1 — Architecture & Planning

**Prompt:**
> I'm working on a take-home assignment for a Forward Deployed Engineer role at Dodge AI. The objective is to build a Graph-Based Data Modeling and Query System over ERP business data.
> I want to design this from the ground up, prioritizing robust architecture and maintainability. Let's start with:
> 1. A comprehensive system architecture (including database choices and their trade-offs)
> 2. A clean, modular folder structure
> 3. A structured graph data model defining all necessary nodes and edges
> 4. A secure LLM prompting strategy for the NL-to-SQL translation, including domain guardrails
> 5. Once we finalize the architecture, we'll implement it iteratively, feature by feature.

**Claude output:**
- Full system architecture diagram (4-layer: Client / API / Core / Data)
- DB decision: PostgreSQL as primary (NL→SQL target), MongoDB optional for chat history,
  Neo4j explicitly rejected (Cypher too hard to prompt reliably)
- 10-node graph model: Customer, SalesOrder, SOItem, Product, Plant, Address,
  Delivery, BillingDoc, JournalEntry, Payment
- 11 directed edge types covering the full Order-to-Cash flow
- Two-pass LLM strategy: guardrail classifier → NL→SQL → SQL validate → execute → answer synthesis
- Folder structure: monorepo with `/server` (Express) and `/client` (Vite + React)

**Key architectural decisions made with AI:**
- Chose PostgreSQL over MongoDB because NL→SQL is the core feature and SQL is the natural
  target when data is relational. MongoDB aggregation pipelines are harder to generate reliably.
- Built graph as an in-memory adjacency map populated from PG on startup — avoids Neo4j
  dependency while still supporting force-directed visualization.
- Two-layer guardrail: regex pre-filter (free, <1ms) + LLM classifier (only on ambiguous queries)
  to minimize API calls while maintaining domain restriction.

---

## Phase 2 — Backend Build

**Prompt:**
> The architecture looks solid and aligns well with our goals. Let's move on to the backend implementation. Please scaffold the core services, including the database seeder, graph builder, and the LLM pipeline. Keep the concerns cleanly separated.

**Claude generated (complete files):**

### `server/db/seed.js`
- Schema DDL for all 10 tables with proper FK constraints and indexes
- Synthetic data generator (50 customers, 200 orders, 300+ items, deliveries, billings, payments)
- CSV loader with column mapping
- Smart detection: uses synthetic if no CSVs present

**Iteration note:** Initial seed only handled CSV format. Real dataset was JSONL — addressed in Phase 4.

### `server/services/schemaRegistry.js`
- Single source of truth for all 10 table definitions
- `buildPromptContext()` — generates the schema string injected into LLM prompts
- `getEdgeDefinitions()` — FK edge definitions used by graph builder

### `server/services/graphBuilder.js`
- Loads all node types from PG with configurable per-type limits
- Resolves edges via FK lookup (in-memory join — no graph DB needed)
- `getNodeWithNeighbors(id)` for the node inspector sidebar
- Graph cached in memory; rebuilds on POST /api/graph/refresh

### `server/services/llmClient.js`
- Unified adapter for Groq, Gemini, and OpenRouter free tiers
- `callLLM()` — buffered mode
- `callLLMStream()` — real SSE streaming (Groq native; word-chunked fallback for others)

### `server/services/guardrail.js`
- Layer 1: 8 regex patterns for obvious off-topic queries (no API call)
- Layer 2: LLM classifier with structured JSON output
- Fails open on LLM error (guardrail outage doesn't block real queries)

### `server/services/llmPipeline.js`
- `runQuery()` — full 5-step buffered pipeline
- `runQueryStream()` — streaming variant with SSE event types:
  `status | sql | results_meta | token | blocked | done | error`
- Auto-retry on SQL error: feeds error message back to LLM for self-correction
- SQL safety gate: regex blocks INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER before execution
- Answer synthesis uses separate prompt with data-grounding instructions

### `server/routes/`
- `graph.routes.js` — GET /api/graph, /meta, /node/:id, POST /refresh
- `chat.routes.js` — POST /api/chat with stream=true SSE support
- `schema.routes.js` — GET /api/schema

---

## Phase 3 — Frontend Build

**Prompt:**
> Great progress on the backend. Next, let's implement the React frontend. We need a force-directed graph canvas for visualization, a node inspector sidebar for metadata, and a real-time chat panel for natural language queries. Please decouple the state management into custom hooks (e.g., useChat, useGraphData).

**Claude generated (complete files):**

### `client/src/components/GraphCanvas.jsx`
- `react-force-graph-2d` with custom `paintNode` canvas renderer
- Radial glow effect on highlighted/hovered nodes
- `getLinkColor` dims non-highlighted edges when results come in
- Directional arrow links + animated particles on highlighted paths
- Auto-zoom to fit on load; click-to-center on node click
- Legend overlay, breadcrumb toolbar, node hover tooltip
- `globalScale`-aware label rendering (labels appear at zoom > 2.5 or when highlighted)

### `client/src/components/NodeInspector.jsx`
- Click-to-inspect sidebar with smart value formatting
- Currency values: ₹ with Indian locale formatting
- Status badges: color-coded green/amber/red
- Date values: human-readable format
- Live fetch of neighbours from `/api/graph/node/:id`
- Clickable neighbour chips

### `client/src/components/ChatPanel.jsx`
- SSE token-by-token streaming with blinking cursor
- Expandable SQL drawer per message (syntax highlighted)
- Expandable results data grid
- Red banner for blocked off-topic queries
- 6 suggested queries on first load
- Status indicator: pulsing amber while thinking

### `client/src/hooks/useChat.js`
- SSE stream reader with event type routing
- Conversation history (last 8 turns sent as context)
- Auto-extracts node IDs from SQL results → drives graph highlighting
- Streaming state management (status text, content accumulation)

### `client/src/hooks/useGraphData.js`
- Graph fetch with highlight state
- `highlightNodes(ids)` / `clearHighlight()` called by chat hook

### `client/src/App.jsx`
- Split-pane layout: graph (flex:1) + node inspector (280px, slides in) + chat (380px)
- Wires all hooks together; node click → inspector; chat result → graph highlight

---

## Phase 4 — Bug Fix: 328 Nodes, 0 Edges

**User reported:** App running, graph showed 328 nodes but 0 edges.

**Diagnosis (Claude):**
Three root causes identified from the screenshot:
1. `seed.js` only detected CSVs — JSONL files in `/data/` were silently ignored
2. `graphBuilder.js` used hardcoded FK column names (`customer_id`, `order_id`, etc.)
   that didn't match the real dataset's field names
3. `schemaRegistry.js` built LLM prompts from hardcoded column names, not actual DB columns

**Fix — complete rewrite of 3 files:**

### New `server/db/seed.js`
- Auto-detects `.jsonl`, `.json`, `.csv` files in `/data/`
- Infers table names from filename using 40+ alias mappings (SAP codes: VBAK, VBAP, LIKP, BKPF etc.)
- Creates tables **dynamically** from actual field names in the data
- Infers column types from values (TEXT / BIGINT / NUMERIC / BOOLEAN / TIMESTAMP)
- Bulk inserts with batch size 500, row-by-row fallback on error
- **FK discovery pass**: checks each column against 8 FK patterns, runs a live spot-check
  JOIN to verify values actually match, writes verified edges to `data/discovered_schema.json`

### New `server/services/graphBuilder.js`
- Reads `data/discovered_schema.json` at startup
- Uses actual `fromKey`/`toKey` from discovered schema to resolve edges
- Falls back to live DB introspection if JSON not present
- Added `__pk` / `__label` aliases in SELECT for uniform node access

### New `server/services/schemaRegistry.js`
- Reads real column names from `discovered_schema.json`
- Builds LLM prompt with actual column names + FK annotations + sample values
- Falls back to static schema if file not present

**Debugging endpoint added:** `GET /api/graph/debug` — shows edge discovery details,
node type samples, and whether `discovered_schema.json` was found.

---

## Phase 5 — Label Fix (User-Applied)

**User applied independently with Antigravity:**

In `GraphCanvas.jsx`, the `paintNode` function used `globalScale` to control label
visibility and font size:

```js
// Original: labels appeared only at globalScale > 2.5
if (globalScale > 2.5 || isHighlighted || isHovered) {
  const fontSize = Math.max(8, 10 / globalScale)
  ...
}
```

The fix removed the `globalScale` dependency so node labels render consistently
at all zoom levels without scaling artifacts — improving readability across the
full zoom range of the force-directed graph.

**Tool:** Antigravity (AI coding assistant)

---

## Prompting Patterns Used

### 1. Role + context front-loading
Every major prompt started with the role ("senior engineer"), the constraint
("deadline: 26 March"), and the stack ("MERN"). This produced architecture-aware
output rather than generic boilerplate.

### 2. Explicit output format requests
Asking for diagrams + prose + code in the same response ("give me the architecture,
then we build feature by feature") kept context aligned across the full session.

### 3. Debugging with screenshot evidence
Sharing the browser screenshot (328 nodes, 0 edges) gave Claude enough visual
context to identify all three root causes without needing access to the live DB.

### 4. Iterative file ownership
Keeping each service in a single file with a clear responsibility (guardrail,
llmPipeline, graphBuilder) made AI-assisted iteration fast — each file could be
fully rewritten without breaking others.

---

## Evaluation Notes

- Total AI-assisted code: ~3,500 lines across 20+ files
- Human decisions: DB choice rationale, JSONL format handling approach,
  `globalScale` label fix strategy, deployment configuration
- All AI output was reviewed, tested, and adapted before use
- The session log above represents the actual conversation flow, not a sanitised summary
