const express = require('express');
const router  = express.Router();
const { getGraph, getGraphMeta, getNodeWithNeighbors, buildGraph } = require('../services/graphBuilder');

// GET /api/graph
router.get('/', (req, res) => {
  const graph = getGraph();
  if (!graph) return res.status(503).json({ error: 'Graph not yet built.' });
  res.json(graph);
});

// GET /api/graph/meta
router.get('/meta', (req, res) => {
  const meta = getGraphMeta();
  if (!meta) return res.status(503).json({ error: 'Graph not built.' });
  res.json(meta);
});

// GET /api/graph/debug — shows edge discovery details
router.get('/debug', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, '../../data/discovered_schema.json');
  const graph = getGraph();

  let discovered = null;
  try {
    if (fs.existsSync(schemaPath)) discovered = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (_) {}

  res.json({
    graphStats:    graph ? { nodes: graph.nodes.length, edges: graph.edges.length } : null,
    edgesFromSchema: discovered?._edges || [],
    nodeTypeSample: graph ? Object.entries(
      graph.nodes.reduce((acc, n) => {
        if (!acc[n.nodeType]) acc[n.nodeType] = n.id;
        return acc;
      }, {})
    ) : [],
    schemaExists: !!discovered,
  });
});

// GET /api/graph/node/:id
router.get('/node/:id', async (req, res) => {
  try {
    const data = await getNodeWithNeighbors(decodeURIComponent(req.params.id));
    if (!data) return res.status(404).json({ error: 'Node not found.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/graph/refresh
router.post('/refresh', async (req, res) => {
  try {
    const graph = await buildGraph();
    res.json({ message: 'Graph rebuilt.', nodeCount: graph.nodes.length, edgeCount: graph.edges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
