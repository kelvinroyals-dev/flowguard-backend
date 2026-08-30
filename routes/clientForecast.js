// routes/clientForecast.js — CLIENT-portal Risk Forecast.
// Same multi-horizon engine and AI briefing as ops, but every response is
// scoped to the caller's own organisation's estates and gated by the client
// RBAC `view_monitoring` permission (platform_admin, facility_manager, member;
// finance is intentionally excluded — it's an operational view, not billing).
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requireClientPermission } = require('../utils/clientPermissions');
const { propertyIdsForUser } = require('../utils/scope');
const { buildHorizonForecast, scopeHorizonsToProperties } = require('../utils/riskForecast');
const { generateBrief } = require('../utils/briefing');
const { hasKey, MODEL, PROVIDER } = require('../utils/llm');

const router = express.Router();
const ownerIdOf = u => u.account_owner_id || u.id;

// Load the full client row so account_owner_id + client_role are available for
// scoping and permission checks (the JWT only carries id/email/role/user_type).
async function loadClientUser(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, user_type, account_owner_id, client_role FROM users WHERE id=$1',
      [req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    if (rows[0].user_type !== 'client') return res.status(403).json({ success: false, error: 'Client accounts only' });
    req.user = { ...req.user, ...rows[0] };
    next();
  } catch (e) { console.error('loadClientUser(forecast)', e); res.status(500).json({ success: false, error: 'Failed to load account' }); }
}

router.use(authenticateToken, loadClientUser, requireClientPermission('view_monitoring'));

// The property_ids owned by the caller's ORGANISATION (properties belong to the
// account owner, so members scope through the owner too).
async function myPropertyIds(req) {
  return propertyIdsForUser(ownerIdOf(req.user));
}

// GET /client-forecast/horizons — scoped now/+1h/+3h/+6h trajectory + triage.
router.get('/horizons', async (req, res) => {
  try {
    const [forecast, ids] = await Promise.all([buildHorizonForecast(), myPropertyIds(req)]);
    const scoped = scopeHorizonsToProperties(forecast, ids);
    res.json({ success: true, data: scoped });
  } catch (err) {
    console.error('GET /client-forecast/horizons', err);
    res.status(500).json({ success: false, error: 'Failed to build risk forecast' });
  }
});

// POST /client-forecast/brief  body: { property_id } | { scope:'portfolio' }
// A single-estate brief can only target one of the caller's own estates: the
// forecast is scoped BEFORE the estate lookup, so a foreign id returns 404.
router.post('/brief', async (req, res) => {
  try {
    const [forecast, ids] = await Promise.all([buildHorizonForecast(), myPropertyIds(req)]);
    const scoped = scopeHorizonsToProperties(forecast, ids);
    const out = await generateBrief({
      forecast: scoped,
      property_id: req.body && req.body.property_id,
      scope: req.body && req.body.scope,
    });
    if (out.notFound) return res.status(404).json({ success: false, error: 'Estate not found' });
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('POST /client-forecast/brief', err);
    res.status(500).json({ success: false, error: 'Failed to build briefing' });
  }
});

// GET /client-forecast/daily — the latest stored morning briefing for this org.
router.get('/daily', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT generated_at, ai, provider, model, briefing, portfolio
         FROM daily_briefings WHERE scope='client' AND owner_id=$1
        ORDER BY generated_at DESC LIMIT 1`, [ownerIdOf(req.user)]);
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    console.error('GET /client-forecast/daily', err);
    res.status(500).json({ success: false, error: 'Failed to load daily briefing' });
  }
});

// GET /client-forecast/status — whether AI briefings are live (for FE labelling).
router.get('/status', (req, res) => {
  res.json({ success: true, data: { llm_enabled: hasKey(), provider: PROVIDER, model: hasKey() ? MODEL : null } });
});

module.exports = router;
