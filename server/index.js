require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { buildGraph } = require('./services/graphBuilder');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '1mb' }));

// Request logger (dev only)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/graph',  require('./routes/graph.routes'));
app.use('/api/chat',   require('./routes/chat.routes'));
app.use('/api/schema', require('./routes/schema.routes'));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Build graph on startup (non-blocking — server starts immediately)
    buildGraph().catch(err => console.warn('Graph build failed:', err.message));

    app.listen(PORT, () => {
      console.log(`\n🚀  ERP Graph server running on http://localhost:${PORT}`);
      console.log(`    LLM provider: ${process.env.LLM_PROVIDER || 'groq'}`);
      console.log(`    LLM model:    ${process.env.LLM_MODEL || 'llama3-70b-8192'}`);
      console.log(`    DB:           ${process.env.PG_DATABASE || 'erp_graph'} @ ${process.env.PG_HOST || 'localhost'}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
