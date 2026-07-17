// App-wide settings (ops center) — single-row JSON store
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const router = express.Router();

// This is the ops-center settings page — a client account has no reason to
// read or write it.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

const DEFAULTS = {
  company_name: 'FlowGuard Solutions',
  contact_email: null, contact_phone: null,
  timezone: 'Africa/Lagos',
  threshold_critical: 85, threshold_warning: 65,
  escalation_minutes: 15, sla_response_minutes: 30,
  email_alerts: true, sms_alerts: false, weekly_digest: true,
  alert_email: null, alert_phone: null,
};

// GET /settings
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT settings FROM app_settings WHERE id = 1');
    const stored = rows[0] ? rows[0].settings : {};
    res.json({ success: true, data: { ...DEFAULTS, ...stored } });
  } catch (err) {
    console.error('GET /settings', err);
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

// PUT /settings  (merge incoming keys into stored blob) — admin/super_admin only.
router.put('/', authenticateToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const incoming = req.body || {};
    // whitelist known keys only
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k in incoming) clean[k] = incoming[k];
    }
    const { rows } = await pool.query(
      `INSERT INTO app_settings (id, settings, updated_at, updated_by)
       VALUES (1, $1::jsonb, NOW(), $2)
       ON CONFLICT (id) DO UPDATE
         SET settings = app_settings.settings || $1::jsonb,
             updated_at = NOW(), updated_by = $2
       RETURNING settings`,
      [JSON.stringify(clean), req.user.id]);
    res.json({ success: true, data: { ...DEFAULTS, ...rows[0].settings } });
  } catch (err) {
    console.error('PUT /settings', err);
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});

// ── Role permissions ──────────────────────────────────────────────
const perms = require('../utils/permissions');

// GET /settings/permissions — the editable role×permission matrix (admin).
router.get('/permissions', requireRole('admin', 'super_admin'), async (_req, res) => {
  try { res.json({ success: true, data: await perms.matrix() }); }
  catch (err) { console.error('GET /settings/permissions', err); res.status(500).json({ success: false, error: 'Failed to load permissions' }); }
});

// PUT /settings/permissions — save overrides. body: { changes: [{role, permission_key, allowed}] } (admin).
router.put('/permissions', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    await perms.saveOverrides((req.body && req.body.changes) || []);
    res.json({ success: true, data: await perms.matrix() });
  } catch (err) { console.error('PUT /settings/permissions', err); res.status(500).json({ success: false, error: 'Failed to save permissions' }); }
});

// GET /settings/permissions/me — the current user's effective permissions
// (any ops user) so the app can gate what they see and can do.
router.get('/permissions/me', async (req, res) => {
  try { res.json({ success: true, data: { role: req.user.role, permissions: await perms.effective(req.user.role) } }); }
  catch (err) { console.error('GET /settings/permissions/me', err); res.status(500).json({ success: false, error: 'Failed to load permissions' }); }
});

module.exports = router;
