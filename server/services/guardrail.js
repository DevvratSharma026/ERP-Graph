/**
 * guardrail.js
 *
 * Two-layer domain guardrail:
 *
 * Layer 1 — fast keyword/regex pre-check (no API call needed)
 *   Instantly rejects obvious off-topic patterns.
 *
 * Layer 2 — LLM classifier (runs only if Layer 1 passes)
 *   Sends a minimal classification prompt to confirm the query
 *   is genuinely ERP-domain before spending tokens on NL→SQL.
 *
 * Returns: { allowed: boolean, reason: string }
 */

const { callLLM } = require('./llmClient');

// Patterns that are clearly off-topic — reject without an API call
const OFF_TOPIC_PATTERNS = [
  /write (me )?(a |an )?(poem|story|essay|haiku|song|joke|code)/i,
  /what is (the meaning of|your name|your purpose|love|life|god)/i,
  /who (are you|created you|made you|is your creator)/i,
  /\b(capital of|population of|history of|recipe|weather|sports|cricket|football|bollywood|movie)\b/i,
  /\b(translate|poem|fiction|creative|fantasy|roleplay|pretend)\b/i,
  /\b(python|javascript|react|node|coding|algorithm|leetcode)\b/i,
  /\b(news|politics|election|president|prime minister)\b/i,
];

// Phrases that strongly suggest ERP domain — fast-pass
const DOMAIN_KEYWORDS = [
  /\b(order|delivery|invoice|billing|payment|customer|product|material|shipment|dispatch)\b/i,
  /\b(sales order|purchase order|billing doc|journal entry|gl account|cost center|profit center)\b/i,
  /\b(deliver|ship|bill|pay|invoice|dispatch|fulfil|fulfill)\b/i,
  /\b(revenue|amount|net value|tax|currency|INR|fiscal year)\b/i,
  /\b(plant|warehouse|shipping point|company code|sales org)\b/i,
  /\b(broken flow|incomplete|pending|cancelled|completed|status)\b/i,
  /\b(trace|track|follow|find|list|show|which|how many|what is the)\b/i,
];

const SYSTEM_PROMPT = `You are a strict domain classifier for an ERP data query system.

The ERP system contains data about:
- Customers, Sales Orders, Sales Order Items
- Deliveries, Plants, Products/Materials
- Billing Documents, Journal Entries, Payments
- Order-to-Cash business flows, financial reporting

Classify the user query as EXACTLY one of:
  IN_DOMAIN  — query is about the ERP data or business operations described above
  OUT_OF_DOMAIN — query is general knowledge, creative writing, coding, small talk, or anything else

Rules:
- Queries about tracing orders, finding customers, billing status, payment analysis = IN_DOMAIN
- Greetings combined with ERP intent (e.g. "hi, show me top orders") = IN_DOMAIN
- Pure greetings, jokes, general questions, off-topic requests = OUT_OF_DOMAIN
- When in doubt, lean OUT_OF_DOMAIN

Respond with ONLY this JSON (no other text):
{"classification": "IN_DOMAIN" | "OUT_OF_DOMAIN", "reason": "<one short sentence>"}`;

async function checkGuardrail(query) {
  const trimmed = query.trim();

  // ── Layer 1: Fast pattern pre-check ────────────────────────────────────

  // Very short queries are likely greetings or noise
  if (trimmed.length < 5) {
    return {
      allowed: false,
      reason: 'Query too short to be a valid ERP question.',
    };
  }

  // Explicit off-topic patterns
  for (const pattern of OFF_TOPIC_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: 'Query appears to be off-topic (not related to ERP business data).',
      };
    }
  }

  // Fast-pass: strong domain keywords present
  const hasDomainKeyword = DOMAIN_KEYWORDS.some(p => p.test(trimmed));

  // ── Layer 2: LLM classifier ─────────────────────────────────────────────
  // Skip if domain keyword already found and query is long enough to be specific
  if (hasDomainKeyword && trimmed.length > 20) {
    return { allowed: true, reason: 'Matched ERP domain keywords.' };
  }

  try {
    const response = await callLLM({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
      maxTokens: 80,
      temperature: 0,
    });

    // Parse classifier response
    const text = response.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: text contains IN_DOMAIN?
      const allowed = text.includes('IN_DOMAIN');
      return { allowed, reason: allowed ? 'LLM classified as in-domain.' : 'LLM classified as out-of-domain.' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      allowed: parsed.classification === 'IN_DOMAIN',
      reason: parsed.reason || 'Domain classification.',
    };
  } catch (err) {
    console.warn('Guardrail LLM call failed, defaulting to allow:', err.message);
    // Fail open — don't block users because the classifier errored
    return { allowed: true, reason: 'Guardrail check skipped (classifier unavailable).' };
  }
}

module.exports = { checkGuardrail };
