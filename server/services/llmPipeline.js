/**
 * llmPipeline.js
 *
 * Orchestrates the full query pipeline:
 *   1. Guardrail check
 *   2. Schema-injected NL→SQL generation
 *   3. SQL safety validation
 *   4. PostgreSQL execution
 *   5. Answer synthesis (data-grounded NL reply)
 *
 * Supports both buffered and streaming modes.
 */

const pool = require('../db/pg');
const { checkGuardrail } = require('./guardrail');
const { callLLM, callLLMStream } = require('./llmClient');
const { buildPromptContext } = require('./schemaRegistry');

// SQL safety: block any mutation keywords
const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE)\b/i;
const SQL_COMMENT   = /--/;

// ─── System prompts ──────────────────────────────────────────────────────────

const SCHEMA_CONTEXT = buildPromptContext();

const NL_TO_SQL_SYSTEM = `You are an expert PostgreSQL query writer for an ERP (Enterprise Resource Planning) system.

DATABASE SCHEMA:
${SCHEMA_CONTEXT}

IMPORTANT RULES:
1. Write ONLY a single SELECT statement. Never write INSERT, UPDATE, DELETE, DROP, or any DDL.
2. Use explicit JOINs (not implicit comma-joins).
3. Always alias tables with short aliases (c for customers, so for sales_orders, etc.)
4. For date comparisons, use DATE literals: WHERE order_date >= '2024-01-01'
5. Limit result sets: add LIMIT 50 unless the user explicitly asks for all records.
6. If a question is ambiguous, make the most reasonable assumption.
7. If the question CANNOT be answered with the available schema, respond with exactly: CANNOT_ANSWER
8. Return ONLY the SQL query — no explanation, no markdown, no backticks.

COMMON PATTERNS:
- Order-to-Cash trace: JOIN sales_orders → deliveries → billing_docs → journal_entries
- Broken flows: LEFT JOIN deliveries ON so.order_id = d.order_id WHERE d.delivery_id IS NULL
- Top N by billing: GROUP BY material_id ORDER BY COUNT(*) DESC LIMIT 10
- Payment status: LEFT JOIN payments ON bd.billing_id = p.billing_id WHERE p.payment_id IS NULL`;

const ANSWER_SYNTHESIS_SYSTEM = `You are a concise ERP business analyst.

Given a user's natural language question and the SQL query results (as JSON), 
provide a clear, accurate, data-backed answer in 2–5 sentences.

Rules:
- Ground every claim in the actual data returned. Do not speculate or invent.
- If the results are empty, say so clearly and suggest why (e.g., "No undelivered orders found in the dataset.")
- For lists, summarise the top items rather than listing all rows.
- Use business language, not SQL terms. Say "billing documents" not "rows in billing_docs".
- Be direct and specific — include actual numbers, names, and dates from the data.
- If results exceed 10 rows, summarise the pattern rather than listing everything.`;

// ─── SQL executor (read-only) ─────────────────────────────────────────────────

async function executeSql(sql) {
  // Safety gate
  if (FORBIDDEN_SQL.test(sql)) {
    throw new Error('SQL contains forbidden operation (non-SELECT). Query rejected.');
  }
  if (SQL_COMMENT.test(sql)) {
    throw new Error('SQL contains comment sequences. Query rejected.');
  }

  // Ensure LIMIT exists (belt-and-suspenders)
  let safeSql = sql.trim().replace(/;?\s*$/, '');
  if (!/\bLIMIT\b/i.test(safeSql)) {
    safeSql += ' LIMIT 100';
  }

  const { rows } = await pool.query(safeSql);
  return rows;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Buffered mode — returns the complete answer as a string.
 */
async function runQuery(userMessage, conversationHistory = []) {
  // Step 1: Guardrail
  const guard = await checkGuardrail(userMessage);
  if (!guard.allowed) {
    return {
      answer: `This system is designed to answer questions about the ERP dataset only. ${guard.reason}`,
      sql: null,
      results: null,
      blocked: true,
    };
  }

  // Step 2: Build conversation context (last 6 turns max)
  const recentHistory = conversationHistory.slice(-6).map(turn => ({
    role: turn.role,
    content: turn.content,
  }));

  // Step 3: NL → SQL
  let sql;
  try {
    sql = await callLLM({
      system: NL_TO_SQL_SYSTEM,
      messages: [
        ...recentHistory,
        { role: 'user', content: userMessage },
      ],
      maxTokens: 500,
      temperature: 0,
    });
    sql = sql.trim().replace(/^```sql\s*/i, '').replace(/```\s*$/, '').trim();
  } catch (err) {
    return {
      answer: 'Sorry, I could not generate a query for that question. Please try rephrasing.',
      sql: null,
      results: null,
      error: err.message,
    };
  }

  if (sql === 'CANNOT_ANSWER') {
    return {
      answer: 'I could not find a way to answer that question with the available ERP data schema. Try rephrasing or asking about orders, deliveries, billing, payments, customers, or products.',
      sql: null,
      results: null,
    };
  }

  // Step 4: Execute SQL with retry on error
  let results;
  let sqlError;
  let attempts = 0;
  let currentSql = sql;

  while (attempts < 2) {
    try {
      results = await executeSql(currentSql);
      break;
    } catch (err) {
      sqlError = err.message;
      attempts++;
      if (attempts >= 2) break;

      // Retry: ask LLM to fix the broken SQL
      try {
        currentSql = await callLLM({
          system: NL_TO_SQL_SYSTEM,
          messages: [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: currentSql },
            { role: 'user', content: `The SQL above produced this error: "${sqlError}". Please fix it and return only the corrected SQL.` },
          ],
          maxTokens: 500,
          temperature: 0,
        });
        currentSql = currentSql.trim().replace(/^```sql\s*/i, '').replace(/```\s*$/, '').trim();
      } catch (_) { break; }
    }
  }

  if (!results) {
    return {
      answer: `I generated a query but it could not be executed: ${sqlError}. Please try rephrasing your question.`,
      sql: currentSql,
      results: null,
      error: sqlError,
    };
  }

  // Step 5: Answer synthesis
  const resultSample = results.slice(0, 50);
  let answer;
  try {
    answer = await callLLM({
      system: ANSWER_SYNTHESIS_SYSTEM,
      messages: [{
        role: 'user',
        content: `Question: ${userMessage}\n\nSQL Results (${results.length} rows):\n${JSON.stringify(resultSample, null, 2)}`,
      }],
      maxTokens: 400,
      temperature: 0.2,
    });
  } catch (err) {
    // Fallback: just describe the results
    answer = results.length > 0
      ? `Found ${results.length} result(s). First result: ${JSON.stringify(results[0])}`
      : 'The query returned no results.';
  }

  return {
    answer,
    sql: currentSql,
    results: resultSample,
    totalRows: results.length,
    blocked: false,
  };
}

/**
 * Streaming mode — calls onChunk(text) progressively.
 * SQL generation and execution are buffered; only answer synthesis streams.
 */
async function runQueryStream(userMessage, conversationHistory = [], onChunk) {
  // Guardrail
  const guard = await checkGuardrail(userMessage);
  if (!guard.allowed) {
    const msg = `This system is designed to answer questions about the ERP dataset only. ${guard.reason}`;
    onChunk({ type: 'blocked', text: msg });
    return;
  }

  onChunk({ type: 'status', text: 'Generating SQL query...' });

  const recentHistory = conversationHistory.slice(-6);

  // NL → SQL
  let sql;
  try {
    sql = await callLLM({
      system: NL_TO_SQL_SYSTEM,
      messages: [...recentHistory, { role: 'user', content: userMessage }],
      maxTokens: 500,
      temperature: 0,
    });
    sql = sql.trim().replace(/^```sql\s*/i, '').replace(/```\s*$/, '').trim();
  } catch (err) {
    onChunk({ type: 'error', text: 'Could not generate SQL query.' });
    return;
  }

  onChunk({ type: 'sql', text: sql });
  onChunk({ type: 'status', text: 'Executing query...' });

  let results;
  try {
    results = await executeSql(sql);
  } catch (err) {
    onChunk({ type: 'error', text: `Query execution failed: ${err.message}` });
    return;
  }

  onChunk({ type: 'results_meta', count: results.length });
  onChunk({ type: 'status', text: 'Synthesising answer...' });

  // Stream the answer
  const resultSample = results.slice(0, 50);
  await callLLMStream({
    system: ANSWER_SYNTHESIS_SYSTEM,
    messages: [{
      role: 'user',
      content: `Question: ${userMessage}\n\nSQL Results (${results.length} rows):\n${JSON.stringify(resultSample, null, 2)}`,
    }],
    maxTokens: 400,
    temperature: 0.2,
    onChunk: (token) => onChunk({ type: 'token', text: token }),
  });

  onChunk({ type: 'done', results: resultSample });
}

module.exports = { runQuery, runQueryStream };
