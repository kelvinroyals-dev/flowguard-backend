// routes/ai.js — the LLM briefing layer over FlowGuard's risk engine (OPS side).
// Runs the (rule-based) horizon forecast, then asks the configured LLM to phrase
// the real numbers as an operational briefing. Falls back to a deterministic
// template when no LLM key is set or the provider errors. Ops sees ALL estates.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { buildHorizonForecast } = require('../utils/riskForecast');
const { generateBrief } = require('../utils/briefing');
const { runOnce } = require('../utils/dailyBrief');
const { askLLM, hasKey, MODEL, PROVIDER } = require('../utils/llm');

const router = express.Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// POST /ai/brief  body: { property_id }  OR  { scope: 'portfolio' }
router.post('/brief', async (req, res) => {
  try {
    const forecast = await buildHorizonForecast();
    const out = await generateBrief({
      forecast,
      property_id: req.body && req.body.property_id,
      scope: req.body && req.body.scope,
    });
    if (out.notFound) return res.status(404).json({ success: false, error: 'Property not found in forecast' });
    return res.json({ success: true, data: out });
  } catch (err) {
    console.error('POST /ai/brief', err);
    res.status(500).json({ success: false, error: 'Failed to build briefing' });
  }
});

// GET /ai/daily — the latest stored ops portfolio briefing (from the morning job).
router.get('/daily', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT generated_at, ai, provider, model, briefing, portfolio, structured
         FROM daily_briefings WHERE scope='ops_portfolio'
        ORDER BY generated_at DESC LIMIT 1`);
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    console.error('GET /ai/daily', err);
    res.status(500).json({ success: false, error: 'Failed to load daily briefing' });
  }
});

// POST /ai/daily/run — regenerate now (ops-only; useful for testing / on demand).
router.post('/daily/run', async (req, res) => {
  try {
    await runOnce();
    const { rows } = await pool.query(
      `SELECT generated_at, ai, provider, model, briefing, portfolio, structured
         FROM daily_briefings WHERE scope='ops_portfolio'
        ORDER BY generated_at DESC LIMIT 1`);
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    console.error('POST /ai/daily/run', err);
    res.status(500).json({ success: false, error: 'Failed to generate briefings' });
  }
});

// POST /ai/ask  { question } — conversational Q&A grounded in the live forecast.
// Answers ONLY from the context we build (no open-web knowledge). Needs an LLM
// key: freeform questions can't be served by a deterministic template.
const ASK_SYSTEM = [
  "You are FlowGuard's flood-risk analyst answering an operations manager's question.",
  'Answer ONLY from the JSON context provided (portfolio triage, per-estate horizons/drivers, and recent events).',
  'Never invent estates, numbers, dates or figures. If the context does not contain the answer, say so plainly.',
  'Risk is 0–100; horizons are projected risk now/+1h/+3h/+6h. Be concise and specific; cite estate names and numbers from the context.',
].join('\n');

router.post('/ask', async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ success: false, error: 'A question is required' });
  if (question.length > 500) return res.status(400).json({ success: false, error: 'Question too long' });
  if (!hasKey()) {
    return res.json({ success: true, data: { ai: false, reason: 'no_key', answer: 'Conversational answers need the AI layer configured — set LLM_API_KEY on the server.' } });
  }
  try {
    const forecast = await buildHorizonForecast();
    let events = [];
    try {
      const { rows } = await pool.query(
        `SELECT e.event_type, e.occurred_at, e.description,
                COALESCE(p.property_name, e.property_id) AS estate
           FROM property_events e
           LEFT JOIN properties p ON p.property_id = e.property_id
          WHERE e.occurred_at >= NOW() - INTERVAL '14 days'
          ORDER BY e.occurred_at DESC LIMIT 25`);
      events = rows;
    } catch (_) { /* events are optional context */ }

    const context = {
      generated_at: forecast.generated_at,
      rain_next_3h_mm: forecast.rain_next_3h_mm,
      portfolio: forecast.portfolio,
      estates: forecast.estates.slice(0, 12).map(e => ({
        name: e.name, current_risk: e.current_risk, horizons: e.horizons,
        critical_window: e.critical_window, anomaly: e.anomaly ? e.anomaly.note : null,
        top_drivers: (e.drivers || []).slice(0, 3).map(d => d.label),
        recommendation: e.recommendation,
      })),
      recent_events: events,
    };
    const out = await askLLM({
      system: ASK_SYSTEM,
      user: `Question: ${question}\n\nContext:\n${JSON.stringify(context)}`,
      maxTokens: 600,
    });
    if (out.ok) return res.json({ success: true, data: { ai: true, answer: out.text } });
    return res.json({ success: true, data: { ai: false, reason: out.reason, status: out.status || null, answer: 'The AI service could not be reached. Check the server LLM configuration.' } });
  } catch (err) {
    console.error('POST /ai/ask', err);
    res.status(500).json({ success: false, error: 'Failed to answer' });
  }
});

// GET /ai/status — is the LLM layer configured, and with which provider?
router.get('/status', (req, res) => {
  res.json({ success: true, data: { llm_enabled: hasKey(), provider: PROVIDER, model: hasKey() ? MODEL : null } });
});

module.exports = router;
