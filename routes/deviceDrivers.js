// ============================================================================
// Device drivers — the third-party hardware abstraction registry.
// A driver adapts a make/model to FlowGuard's canonical telemetry (field_map)
// and command model (commands). Fleet-wide FlowGuard-operations tooling:
// closed to clients and service-provider (tenant) users.
// ============================================================================
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient, isSpUser } = require('../utils/scope');
const { invalidate } = require('../utils/deviceDrivers');

router.use(authenticateToken);
router.use((req, res, next) => (isClient(req) || isSpUser(req))
  ? res.status(403).json({ success: false, error: 'Driver management is restricted to FlowGuard operations' }) : next());
const canManage = requirePermission('devices.manage');

// The command vocabulary a driver may advertise (mirrors monitoring.js).
const COMMAND_VOCAB = [
  'firmware_update', 'reset', 'recalibrate', 'apply_config',
  'force_sync', 'connectivity_test', 'self_test', 'reconnect_modem', 'refresh_gps',
  'diagnostic_bundle', 'locate', 'set_reporting_interval', 'set_thresholds',
  'enable_sensor', 'disable_sensor', 'reset_config', 'factory_reset', 'reprovision',
];
const AUTH_TYPES = ['device_key', 'hmac', 'bearer'];

function cleanCommands(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(c => COMMAND_VOCAB.includes(c)))];
}
function asObject(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function cleanKey(k) { return String(k || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_\-.]/g, '').slice(0, 48); }

// GET /device-drivers — list with a live device count per driver
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*, (SELECT COUNT(*)::int FROM sensors s WHERE s.driver_id = d.id) AS device_count
        FROM device_drivers d ORDER BY d.native DESC, d.name ASC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET drivers', err); res.status(500).json({ success: false, error: 'Failed to load drivers' }); }
});

// GET /device-drivers/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM device_drivers WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Driver not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('GET driver', err); res.status(500).json({ success: false, error: 'Failed to load driver' }); }
});

// POST /device-drivers  { key, name, vendor?, model?, auth_type?, capabilities?, field_map?, commands?, notes? }
router.post('/', canManage, async (req, res) => {
  try {
    const b = req.body || {};
    const key = cleanKey(b.key);
    if (!key) return res.status(400).json({ success: false, error: 'A driver key (slug) is required' });
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ success: false, error: 'A driver name is required' });
    const auth = AUTH_TYPES.includes(b.auth_type) ? b.auth_type : 'device_key';
    const { rows } = await pool.query(
      `INSERT INTO device_drivers (key, name, vendor, model, native, auth_type, capabilities, field_map, commands, notes)
       VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8,$9) RETURNING *`,
      [key, String(b.name).trim().slice(0, 120), b.vendor ? String(b.vendor).slice(0, 120) : null,
       b.model ? String(b.model).slice(0, 120) : null, auth,
       JSON.stringify(asObject(b.capabilities)), JSON.stringify(asObject(b.field_map)),
       cleanCommands(b.commands), b.notes ? String(b.notes).slice(0, 2000) : null]);
    invalidate();
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'A driver with that key already exists' });
    console.error('POST driver', err); res.status(500).json({ success: false, error: 'Failed to create driver' });
  }
});

// PUT /device-drivers/:id  — update (the native driver's key/native flag are immutable)
router.put('/:id', canManage, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = (await pool.query('SELECT * FROM device_drivers WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Driver not found' });
    const b = req.body || {};
    const auth = AUTH_TYPES.includes(b.auth_type) ? b.auth_type : cur.auth_type;
    const { rows } = await pool.query(
      `UPDATE device_drivers SET
         name = $2, vendor = $3, model = $4, auth_type = $5,
         capabilities = $6, field_map = $7, commands = $8, notes = $9,
         active = $10, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, b.name ? String(b.name).trim().slice(0, 120) : cur.name,
       b.vendor !== undefined ? (b.vendor ? String(b.vendor).slice(0, 120) : null) : cur.vendor,
       b.model !== undefined ? (b.model ? String(b.model).slice(0, 120) : null) : cur.model, auth,
       JSON.stringify(b.capabilities !== undefined ? asObject(b.capabilities) : cur.capabilities),
       JSON.stringify(b.field_map !== undefined ? asObject(b.field_map) : cur.field_map),
       b.commands !== undefined ? cleanCommands(b.commands) : cur.commands,
       b.notes !== undefined ? (b.notes ? String(b.notes).slice(0, 2000) : null) : cur.notes,
       b.active !== undefined ? !!b.active : cur.active]);
    invalidate();
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT driver', err); res.status(500).json({ success: false, error: 'Failed to update driver' }); }
});

module.exports = router;
