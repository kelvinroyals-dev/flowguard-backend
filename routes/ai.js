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
const { hasKey, MODEL, PROVIDER } = require('../utils/llm');

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

// GET /ai/status — is the LLM layer configured, and with which provider?
router.get('/status', (req, res) => {
  res.json({ success: true, data: { llm_enabled: hasKey(), provider: PROVIDER, model: hasKey() ? MODEL : null } });
});

module.exports = router;
