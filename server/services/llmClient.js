/**
 * llmClient.js
 *
 * Thin wrapper around free-tier LLM providers.
 * Provider is set via LLM_PROVIDER env var: groq | gemini | openrouter
 *
 * All providers expose the same callLLM({ system, messages, maxTokens, temperature }) interface.
 */

require('dotenv').config();

const PROVIDER  = (process.env.LLM_PROVIDER  || 'groq').toLowerCase();
const API_KEY   = process.env.LLM_API_KEY    || '';
const MODEL     = process.env.LLM_MODEL      || 'llama3-70b-8192';

if (!API_KEY) {
  console.warn('⚠️  LLM_API_KEY not set — LLM features will fail. Set it in server/.env');
}

// ─── Provider implementations ─────────────────────────────────────────────

async function callGroq({ system, messages, maxTokens = 1000, temperature = 0.1 }) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL || 'llama3-70b-8192',
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini({ system, messages, maxTokens = 1000, temperature = 0.1 }) {
  const geminiModel = process.env.LLM_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${API_KEY}`;

  // Gemini uses a different message format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function callOpenRouter({ system, messages, maxTokens = 1000, temperature = 0.1 }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'HTTP-Referer': 'https://erp-graph.app',
    },
    body: JSON.stringify({
      model: MODEL || 'meta-llama/llama-3-70b-instruct',
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ─── Unified interface ────────────────────────────────────────────────────

async function callLLM(options) {
  switch (PROVIDER) {
    case 'groq':        return callGroq(options);
    case 'gemini':      return callGemini(options);
    case 'openrouter':  return callOpenRouter(options);
    default:
      throw new Error(`Unknown LLM provider: ${PROVIDER}. Use groq | gemini | openrouter`);
  }
}

/**
 * Streaming variant — calls res.write(chunk) for each token.
 * Currently implemented for Groq; others fall back to buffered.
 */
async function callLLMStream({ system, messages, maxTokens = 1000, temperature = 0.1, onChunk }) {
  if (PROVIDER !== 'groq') {
    // Non-streaming fallback — simulate streaming by chunking the response
    const full = await callLLM({ system, messages, maxTokens, temperature });
    const words = full.split(' ');
    for (const word of words) {
      onChunk(word + ' ');
      await new Promise(r => setTimeout(r, 10));
    }
    return full;
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL || 'llama3-70b-8192',
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq streaming error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const data = line.replace('data: ', '').trim();
      if (data === '[DONE]') break;
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          fullText += token;
          onChunk(token);
        }
      } catch (_) {}
    }
  }

  return fullText;
}

module.exports = { callLLM, callLLMStream };
