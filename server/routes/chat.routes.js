const express = require('express');
const router = express.Router();
const { runQuery, runQueryStream } = require('../services/llmPipeline');

/**
 * POST /api/chat
 * Body: { message: string, history: Array<{role, content}>, stream?: boolean }
 */
router.post('/', async (req, res) => {
  const { message, history = [], stream = false } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  if (message.trim().length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 chars).' });
  }

  // ── Streaming mode ──────────────────────────────────────────────────────
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await runQueryStream(message.trim(), history, sendEvent);
    } catch (err) {
      sendEvent({ type: 'error', text: err.message });
    } finally {
      res.end();
    }
    return;
  }

  // ── Buffered mode ───────────────────────────────────────────────────────
  try {
    const result = await runQuery(message.trim(), history);
    res.json(result);
  } catch (err) {
    console.error('Chat pipeline error:', err);
    res.status(500).json({ error: 'Internal error processing your query.' });
  }
});

module.exports = router;
