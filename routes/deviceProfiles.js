// ============================================================================
// Device profiles — versioned config bundles assignable to many Sentinels.
// Assigning (or editing) a profile queues an 'apply_config' command and marks
// the device's applied version stale, so drift (assigned ≠ applied) is visible
// until the device checks in and confirms. Staff-only.
// ============================================================================
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient } = require('../utils/scope');

router.use(authenticateToken);
router.use((req, res, next) => isClient(req)
  ? res.status(403).json({ success: false, error: 'Not authorised' }) : next());
const canManage = requirePermission('devices.manage');

// Canonical config schema — coerce & bound so a profile can't hold junk.
const FIELDS = {
  telemetry_interval_sec: { def: 60,  min: 5,  max: 3600 },
  water_poll_sec:         { def: 10,  min: 1,  max: 600 },
  offline_alert_min:      { def: 5,   min: 1,  max: 240 },
  high_level_pct:         { def: 70,  min: 1,  max: 100 },
  critical_level_pct:     { def: 85,  min: 1,  max: 100 },
};
const ENUMS = { camera_mode: ['off', 'event', 'continuous'], firmware_channel: ['stable', 'beta', 'internal'] };
function cleanConfig(raw) {
  const c = {};
  for (const [k, r] of Object.entries(FIELDS)) {
    let v = raw && raw[k] != null ? parseInt(raw[k], 10) : r.def;
    if (isNaN(v)) v = r.def;
    c[k] = Math.max(r.min, Math.min(r.max, v));
  }
  c.camera_mode = ENUMS.camera_mode.includes(raw && raw.camera_mode) ? raw.camera_mode : 'event';
  c.firmware_channel = ENUMS.firmware_channel.includes(raw && raw.firmware_channel) ? raw.firmware_channel : 'stable';
  return c;
}

// Queue a config push to a set of sensors and reset their applied version.
async function pushConfig(profileId, sensorIds, userId) {
  const p = (await pool.query('SELECT config, version FROM device_profiles WHERE id = $1', [profileId])).rows[0];
  if (!p) return;
  for (const sid of sensorIds) {
    const cmd = (await pool.query(
      `INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note)
       VALUES ($1,'apply_config',$2,$3,$4) RETURNING id`,
      [sid, JSON.stringify({ profile_id: profileId, version: p.version, config: p.config }), userId, `Apply profile #${profileId} v${p.version}`])).rows[0];
    await pool.query('UPDATE sensors SET applied_profile_version = NULL WHERE sensor_id = $1', [sid]);
  }
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM sensors s WHERE s.profile_id = p.id) AS assigned,
             (SELECT COUNT(*)::int FROM sensors s WHERE s.profile_id = p.id
                AND (s.applied_profile_version IS DISTINCT FROM p.version)) AS drifted
        FROM device_profiles p LEFT JOIN users u ON u.id = p.created_by
       ORDER BY p.name`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET profiles', err); res.status(500).json({ success: false, error: 'Failed to load profiles' }); }
});

router.post('/', canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ success: false, error: 'Name required' });
    const cfg = cleanConfig(b.config || {});
    const { rows } = await pool.query(
      `INSERT INTO device_profiles (name, description, config, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(b.name).trim().slice(0, 80), b.description || null, JSON.stringify(cfg), req.user.id]);
    await pool.query(`INSERT INTO device_profile_history (profile_id, version, config, changed_by, note) VALUES ($1,1,$2,$3,'created')`,
      [rows[0].id, JSON.stringify(cfg), req.user.id]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'A profile with that name exists' });
    console.error('POST profile', err); res.status(500).json({ success: false, error: 'Failed to create profile' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const p = (await pool.query('SELECT p.*, u.full_name AS created_by_name FROM device_profiles p LEFT JOIN users u ON u.id=p.created_by WHERE p.id=$1', [id])).rows[0];
    if (!p) return res.status(404).json({ success: false, error: 'Not found' });
    const history = (await pool.query('SELECT h.version, h.changed_at, h.note, u.full_name AS changed_by_name FROM device_profile_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.profile_id=$1 ORDER BY h.version DESC', [id])).rows;
    const devices = (await pool.query(
      `SELECT sensor_id, name, applied_profile_version,
              (applied_profile_version IS DISTINCT FROM $2) AS drift
         FROM sensors WHERE profile_id = $1 ORDER BY name`, [id, p.version])).rows;
    res.json({ success: true, data: { ...p, history, devices } });
  } catch (err) { console.error('GET profile', err); res.status(500).json({ success: false, error: 'Failed to load profile' }); }
});

// PUT — new config version + snapshot + re-push to all assigned devices.
router.put('/:id', canManage, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = (await pool.query('SELECT * FROM device_profiles WHERE id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Not found' });
    const cfg = cleanConfig((req.body || {}).config || {});
    const version = cur.version + 1;
    await pool.query('UPDATE device_profiles SET config=$2, version=$3, description=COALESCE($4,description), updated_at=NOW() WHERE id=$1',
      [id, JSON.stringify(cfg), version, (req.body || {}).description || null]);
    await pool.query('INSERT INTO device_profile_history (profile_id, version, config, changed_by, note) VALUES ($1,$2,$3,$4,$5)',
      [id, version, JSON.stringify(cfg), req.user.id, (req.body || {}).note || 'config updated']);
    const ids = (await pool.query('SELECT sensor_id FROM sensors WHERE profile_id=$1', [id])).rows.map(r => r.sensor_id);
    await pushConfig(id, ids, req.user.id);
    res.json({ success: true, data: { version, repushed: ids.length } });
  } catch (err) { console.error('PUT profile', err); res.status(500).json({ success: false, error: 'Failed to update profile' }); }
});

// Assign to a device set (fleet / tag / explicit sensor_ids) and push config.
router.post('/:id/assign', canManage, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await pool.query('SELECT 1 FROM device_profiles WHERE id=$1', [id])).rows.length)
      return res.status(404).json({ success: false, error: 'Not found' });
    const b = req.body || {};
    let ids = Array.isArray(b.sensor_ids) ? b.sensor_ids : [];
    if (!ids.length && b.target_type === 'fleet') ids = (await pool.query('SELECT sensor_id FROM sensors')).rows.map(r => r.sensor_id);
    else if (!ids.length && b.target_type === 'tag' && b.target_value) ids = (await pool.query('SELECT sensor_id FROM sensors WHERE $1 = ANY(tags)', [b.target_value])).rows.map(r => r.sensor_id);
    if (!ids.length) return res.status(400).json({ success: false, error: 'No devices matched' });
    await pool.query('UPDATE sensors SET profile_id=$1 WHERE sensor_id = ANY($2)', [id, ids]);
    await pushConfig(id, ids, req.user.id);
    res.json({ success: true, data: { assigned: ids.length } });
  } catch (err) { console.error('assign profile', err); res.status(500).json({ success: false, error: 'Failed to assign' }); }
});

module.exports = router;
