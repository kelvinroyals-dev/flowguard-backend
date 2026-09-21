// ============================================================================
// Firmware releases + staged rollouts (deployment rings) with rollback.
// Staff-only. Rollouts queue firmware_update device_commands ring by ring;
// devices under an active protection window are deferred. "updated" reflects
// the device actually reporting the target version.
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

// sensor_ids currently covered by an active protection window (deferred from rollout).
async function protectedSet(sensorIds) {
  if (!sensorIds.length) return new Set();
  const { rows } = await pool.query(`
    SELECT DISTINCT s.sensor_id
      FROM sensors s
      JOIN device_protection_windows w
        ON w.cancelled_at IS NULL AND NOW() BETWEEN w.starts_at AND w.ends_at
       AND ( w.scope_type = 'fleet'
             OR (w.scope_type = 'sensor'   AND w.scope_value = s.sensor_id)
             OR (w.scope_type = 'property' AND w.scope_value = s.property_id)
             OR (w.scope_type = 'tag'      AND w.scope_value = ANY(s.tags)) )
     WHERE s.sensor_id = ANY($1)`, [sensorIds]);
  return new Set(rows.map(r => r.sensor_id));
}

// ── Releases ──────────────────────────────────────────────────────────────
router.get('/releases', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM sensors s WHERE s.firmware_version = r.version) AS devices_on_version
        FROM firmware_releases r LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET releases', err); res.status(500).json({ success: false, error: 'Failed to load releases' }); }
});

router.post('/releases', canManage, async (req, res) => {
  try {
    const b = req.body || {};
    const version = String(b.version || '').trim();
    if (!/^[\w.\-]{1,40}$/.test(version)) return res.status(400).json({ success: false, error: 'Valid version required (e.g. 2.4.1)' });
    const channel = ['stable', 'beta', 'internal'].includes(b.channel) ? b.channel : 'stable';
    const { rows } = await pool.query(
      `INSERT INTO firmware_releases (version, channel, notes, artifact_url, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [version, channel, b.notes || null, b.artifact_url || null, req.user.id]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'That version already exists' });
    console.error('POST release', err); res.status(500).json({ success: false, error: 'Failed to create release' });
  }
});

// ── Rollouts ──────────────────────────────────────────────────────────────
router.get('/rollouts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ro.*, fr.version, fr.channel, u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM firmware_rollout_targets t WHERE t.rollout_id = ro.id) AS total,
             (SELECT COUNT(*)::int FROM firmware_rollout_targets t
                JOIN sensors s ON s.sensor_id = t.sensor_id
               WHERE t.rollout_id = ro.id AND s.firmware_version = fr.version) AS updated
        FROM firmware_rollouts ro
        JOIN firmware_releases fr ON fr.id = ro.release_id
        LEFT JOIN users u ON u.id = ro.created_by
       ORDER BY ro.created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET rollouts', err); res.status(500).json({ success: false, error: 'Failed to load rollouts' }); }
});

// Create a rollout: snapshot the target devices, bucket them into rings.
router.post('/rollouts', canManage, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const rel = (await client.query('SELECT id, version FROM firmware_releases WHERE id = $1', [parseInt(b.release_id, 10)])).rows[0];
    if (!rel) return res.status(404).json({ success: false, error: 'Release not found' });
    const target_type = ['fleet', 'tag'].includes(b.target_type) ? b.target_type : 'fleet';
    if (target_type === 'tag' && !b.target_value) return res.status(400).json({ success: false, error: 'Tag required' });
    let rings = Array.isArray(b.rings) ? b.rings.map(n => parseInt(n, 10)).filter(n => n > 0 && n <= 100) : [5, 25, 100];
    rings = [...new Set(rings)].sort((a, c) => a - c);
    if (!rings.length || rings[rings.length - 1] !== 100) rings.push(100);

    // eligible devices = fleet, or those carrying the tag; exclude ones already on the target version
    const dq = target_type === 'tag'
      ? await client.query(`SELECT sensor_id, firmware_version FROM sensors WHERE $1 = ANY(tags) AND (firmware_version IS DISTINCT FROM $2) ORDER BY md5(sensor_id)`, [b.target_value, rel.version])
      : await client.query(`SELECT sensor_id, firmware_version FROM sensors WHERE (firmware_version IS DISTINCT FROM $1) ORDER BY md5(sensor_id)`, [rel.version]);
    const devices = dq.rows;
    if (!devices.length) return res.status(400).json({ success: false, error: 'No eligible devices (all already on this version, or none match).' });

    await client.query('BEGIN');
    const ro = (await client.query(
      `INSERT INTO firmware_rollouts (release_id, name, target_type, target_value, rings, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [rel.id, b.name || `Rollout to ${rel.version}`, target_type, target_type === 'fleet' ? null : b.target_value, rings, req.user.id])).rows[0];

    const total = devices.length;
    for (let i = 0; i < total; i++) {
      const pct = ((i + 1) / total) * 100;
      let ring = rings.findIndex(r => pct <= r);
      if (ring < 0) ring = rings.length - 1;
      await client.query(
        `INSERT INTO firmware_rollout_targets (rollout_id, sensor_id, ring, from_version)
         VALUES ($1,$2,$3,$4)`, [ro.id, devices[i].sensor_id, ring, devices[i].firmware_version || null]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...ro, total } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST rollout', err); res.status(500).json({ success: false, error: 'Failed to create rollout' });
  } finally { client.release(); }
});

// Detail: per-ring counts + failed devices, statuses judged against live firmware.
router.get('/rollouts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ro = (await pool.query(`
      SELECT ro.*, fr.version, fr.channel FROM firmware_rollouts ro
        JOIN firmware_releases fr ON fr.id = ro.release_id WHERE ro.id = $1`, [id])).rows[0];
    if (!ro) return res.status(404).json({ success: false, error: 'Not found' });
    const targets = (await pool.query(`
      SELECT t.sensor_id, t.ring, t.from_version, t.status AS stored_status, t.command_id,
             s.name, s.firmware_version AS current_version,
             dc.status AS cmd_status
        FROM firmware_rollout_targets t
        JOIN sensors s ON s.sensor_id = t.sensor_id
        LEFT JOIN device_commands dc ON dc.id = t.command_id
       WHERE t.rollout_id = $1 ORDER BY t.ring, s.name`, [id])).rows;
    const eff = t => t.current_version === ro.version ? 'updated'
      : t.cmd_status === 'failed' ? 'failed' : t.stored_status;
    const rings = ro.rings.map((pct, idx) => {
      const inRing = targets.filter(t => t.ring === idx);
      const c = s => inRing.filter(t => eff(t) === s).length;
      return { index: idx, percent: pct, total: inRing.length,
               pending: c('pending'), queued: c('queued'), updated: c('updated'), failed: c('failed'),
               open: idx <= ro.current_ring };
    });
    const failed = targets.filter(t => eff(t) === 'failed').map(t => ({ sensor_id: t.sensor_id, name: t.name }));
    res.json({ success: true, data: { ...ro, rings, failed, total: targets.length } });
  } catch (err) { console.error('GET rollout', err); res.status(500).json({ success: false, error: 'Failed to load rollout' }); }
});

// Advance to the next ring: queue firmware_update for its still-pending, unprotected devices.
router.post('/rollouts/:id/advance', canManage, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ro = (await pool.query(`
      SELECT ro.*, fr.version FROM firmware_rollouts ro JOIN firmware_releases fr ON fr.id = ro.release_id
       WHERE ro.id = $1`, [id])).rows[0];
    if (!ro) return res.status(404).json({ success: false, error: 'Not found' });
    if (ro.status !== 'active') return res.status(409).json({ success: false, error: `Rollout is ${ro.status}` });
    const nextRing = ro.current_ring + 1;
    if (nextRing >= ro.rings.length) return res.status(409).json({ success: false, error: 'Already at the final ring' });

    const pend = (await pool.query(
      `SELECT id, sensor_id FROM firmware_rollout_targets
        WHERE rollout_id = $1 AND ring <= $2 AND status = 'pending'`, [id, nextRing])).rows;
    const deferred = await protectedSet(pend.map(p => p.sensor_id));
    let queued = 0;
    for (const t of pend) {
      if (deferred.has(t.sensor_id)) continue; // under protection window — leave pending
      const cmd = (await pool.query(
        `INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note)
         VALUES ($1,'firmware_update',$2,$3,$4) RETURNING id`,
        [t.sensor_id, JSON.stringify({ firmware_version: ro.version }), req.user.id, `Rollout #${id} ring ${nextRing + 1}`])).rows[0];
      await pool.query(`UPDATE firmware_rollout_targets SET status='queued', command_id=$2, updated_at=NOW() WHERE id=$1`, [t.id, cmd.id]);
      queued++;
    }
    await pool.query(`UPDATE firmware_rollouts SET current_ring=$2, updated_at=NOW() WHERE id=$1`, [id, nextRing]);
    res.json({ success: true, data: { ring: nextRing + 1, queued, deferred: deferred.size } });
  } catch (err) { console.error('advance rollout', err); res.status(500).json({ success: false, error: 'Failed to advance' }); }
});

function setStatus(status) {
  return async (req, res) => {
    try {
      const { rowCount } = await pool.query(`UPDATE firmware_rollouts SET status=$2, updated_at=NOW() WHERE id=$1`, [parseInt(req.params.id, 10), status]);
      if (!rowCount) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true });
    } catch (err) { console.error('rollout status', err); res.status(500).json({ success: false, error: 'Failed' }); }
  };
}
router.post('/rollouts/:id/pause', canManage, setStatus('paused'));
router.post('/rollouts/:id/resume', canManage, setStatus('active'));
router.post('/rollouts/:id/cancel', canManage, setStatus('cancelled'));

// Rollback: re-flash the prior version for devices already queued/updated.
router.post('/rollouts/:id/rollback', canManage, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ro = (await pool.query('SELECT * FROM firmware_rollouts WHERE id = $1', [id])).rows[0];
    if (!ro) return res.status(404).json({ success: false, error: 'Not found' });
    const targets = (await pool.query(`
      SELECT t.id, t.sensor_id, t.from_version, s.firmware_version AS current_version
        FROM firmware_rollout_targets t JOIN sensors s ON s.sensor_id = t.sensor_id
       WHERE t.rollout_id = $1 AND t.status IN ('queued','updated')`, [id])).rows;
    let reverted = 0;
    for (const t of targets) {
      if (!t.from_version) continue; // nothing to revert to
      const cmd = (await pool.query(
        `INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note)
         VALUES ($1,'firmware_update',$2,$3,$4) RETURNING id`,
        [t.sensor_id, JSON.stringify({ firmware_version: t.from_version }), req.user.id, `Rollback rollout #${id}`])).rows[0];
      await pool.query(`UPDATE firmware_rollout_targets SET status='pending', command_id=$2, updated_at=NOW() WHERE id=$1`, [t.id, cmd.id]);
      reverted++;
    }
    await pool.query(`UPDATE firmware_rollouts SET status='rolled_back', updated_at=NOW() WHERE id=$1`, [id]);
    res.json({ success: true, data: { reverted } });
  } catch (err) { console.error('rollback rollout', err); res.status(500).json({ success: false, error: 'Failed to roll back' }); }
});

module.exports = router;
