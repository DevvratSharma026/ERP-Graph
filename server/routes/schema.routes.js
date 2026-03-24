const express = require('express');
const router  = express.Router();
const { buildPromptContext, getTableList, getLiveSchema } = require('../services/schemaRegistry');

// GET /api/schema — discovered schema for UI/debug
router.get('/', (req, res) => {
  const tables = getTableList();
  res.json({ tables, promptContext: buildPromptContext() });
});

// GET /api/schema/live — introspect DB directly (useful to debug edge issues)
router.get('/live', async (req, res) => {
  try {
    const schema = await getLiveSchema();
    res.json(schema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
