// Alerts — ops center
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient } = require('../utils/scope');
const realtime = require('../realtime/io');
const router = express.Router();

// GET /alerts
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Client-role users only see alerts for their own client record(s); ops see all.
    const { isClient, clientIdsForUser } = require('../utils/scope');
    let clientFilter = '';
    let params = [];
    if (isClient(req)) {
      const ids = await clientIdsForUser(req.user.id);
      if (!ids.length) return res.json({ success: true, data: [], summary: { total: 0, critical: 0, active: 0 } });
      clientFilter = ` AND a.client_id = ANY($1)`;
      params = [ids];
    }
    const { rows } = await pool.query(`
      SELECT a.alert_id, a.alert_id AS id, a.sensor_id, a.client_id, a.severity,
             a.alert_type, a.alert_type AS type, a.description, a.location,
             INITCAP(REPLACE(a.alert_type, '_', ' ')) AS title,
             a.status, a.assigned_team_id, a.created_at, a.created_at AS timestamp,
             a.resolved_at, a.property_id,
             COALESCE(p.property_name, c.name) AS property,
             COALESCE(p.property_name, c.name) AS property_name,
             c.name AS site_name,
             s.name AS sensor_name,
             ft.team_name AS assigned_team,
             (SELECT t.ticket_id FROM tickets t
               WHERE t.alert_id = a.alert_id
               ORDER BY t.created_at DESC LIMIT 1) AS ticket_id
      FROM alerts a
      LEFT JOIN clients c ON a.client_id = c.id
      LEFT JOIN properties p ON p.property_id = a.property_id
      LEFT JOIN sensors s ON s.sensor_id = a.sensor_id
      LEFT JOIN field_teams ft ON a.assigned_team_id = ft.team_id
      WHERE a.status != 'closed'${clientFilter}
      ORDER BY CASE a.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
               WHEN 'moderate' THEN 3 ELSE 4 END, a.created_at DESC
    `, params);
    res.json({
      success: true,
      data: rows,
      summary: {
        total: rows.length,
        critical: rows.filter(r => r.severity === 'critical').length,
        active: rows.filter(r => r.status === 'active').length,
      },
    });
  } catch (err) {
    console.error('GET /alerts', err);
    res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

// POST /alerts — create an alert (sensor ingestion / manual) + broadcast.
// Manual creation is an ops action; sensors report via /monitoring/readings
// with a device key, not this user-facing endpoint.
router.post('/', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const b = req.body || {};
    const alertId = 'ALT-' + Date.now() + '-' + Math.floor(Math.random()*900+100);
    const { rows } = await pool.query(
      `INSERT INTO alerts (alert_id, sensor_id, client_id, severity, alert_type, description, location, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
      [alertId, b.sensor_id||null, b.client_id||null, b.severity||'moderate',
       b.alert_type||'System Alert', b.description||null, b.location||null]);
    realtime.events.alertNew(rows[0]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /alerts', err);
    res.status(500).json({ success: false, error: 'Failed to create alert' });
  }
});

// PUT /alerts/:id/assign  body: { team_id }
router.put('/:id/assign', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { team_id } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE alerts SET assigned_team_id=$1, status='dispatched'
       WHERE alert_id=$2 RETURNING *`, [team_id, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to assign alert' });
  }
});

// PUT /alerts/:id/resolve
router.put('/:id/resolve', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(
      `UPDATE alerts SET status='resolved', resolved_at=NOW()
       WHERE alert_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Alert not found' });
    realtime.events.alertResolved(rows[0]);
    // Notify the affected client that the incident is cleared.
    if (rows[0].client_id) {
      const nt = require('../utils/notify');
      nt.userIdForClient(rows[0].client_id).then(uid => uid && nt.notify(uid, {
        type: 'alert', title: 'Alert resolved',
        message: (rows[0].alert_type ? String(rows[0].alert_type).replace(/_/g, ' ') : 'An alert') + ' has been resolved by our team.',
        link: '#alerts',
      }));
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to resolve alert' });
  }
});

// PUT /alerts/:id/reopen — put a resolved alert back into active state.
router.put('/:id/reopen', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(
      `UPDATE alerts SET status='active', resolved_at=NULL
       WHERE alert_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Alert not found' });
    if (realtime.events.alertNew) realtime.events.alertNew(rows[0]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /alerts/:id/reopen', err);
    res.status(500).json({ success: false, error: 'Failed to reopen alert' });
  }
});


// ══════════════════════════════════════════════════════════════
//  DISPATCH — the loop that was missing.
//  An alert fires → ops assigns a team → a work order is created →
//  the crew completes it in the field app → a property_event is written
//  → the client portal's outcomes finally reflect real work.
// ══════════════════════════════════════════════════════════════

// POST /alerts/:alertId/dispatch  { team_id, work_type, note? }
router.post('/:alertId/dispatch', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

  const { team_id, work_type, note } = req.body || {};
  const VALID_WORK = ['silt_clearing', 'enzyme_refill', 'node_repair', 'maintenance', 'inspection'];
  if (!team_id) return res.status(400).json({ success: false, error: 'A team is required' });
  if (work_type && !VALID_WORK.includes(work_type)) {
    return res.status(400).json({ success: false, error: `work_type must be one of: ${VALID_WORK.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // resolve the alert, its client, and the property its sensor sits on
    const { rows: aRows } = await client.query(`
      SELECT a.alert_id, a.severity, a.alert_type, a.description, a.status,
             a.client_id, a.sensor_id, s.name AS sensor_name,
             -- the asset in trouble: the alert's own, else the node's primary
             COALESCE(a.property_id, sc.property_id) AS property_id,
             p.property_name AS asset_name
        FROM alerts a
        LEFT JOIN sensors s ON s.sensor_id = a.sensor_id
        LEFT JOIN sentinel_coverage sc ON sc.sensor_id = a.sensor_id AND sc.is_primary
        LEFT JOIN properties p ON p.property_id = COALESCE(a.property_id, sc.property_id)
       WHERE a.alert_id = $1
       FOR UPDATE OF a`, [req.params.alertId]);
    if (!aRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Alert not found' }); }
    const a = aRows[0];
    if (['resolved', 'closed'].includes(a.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Alert is already resolved' });
    }

    // team must exist and be free
    const { rows: tRows } = await client.query(
      `SELECT team_id, team_name, status FROM field_teams WHERE team_id = $1 FOR UPDATE`, [team_id]);
    if (!tRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Team not found' }); }

    const ticketId = 'WO-' + Date.now().toString(36).toUpperCase();
    const wt = work_type || 'maintenance';
    const title = `${wt.replace(/_/g, ' ')} — ${a.asset_name || a.sensor_name || a.alert_type || 'alert'}`;

    await client.query(`
      INSERT INTO tickets (ticket_id, alert_id, client_id, property_id, title, description,
                           severity, status, assigned_team, work_type, created_by, assigned_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'assigned',$8,$9,$10,NOW())`,
      [ticketId, a.alert_id, a.client_id, a.property_id, title,
       note || a.description || '', a.severity, team_id, wt, req.user.id]);

    await client.query(
      `UPDATE alerts SET status='dispatched', assigned_team_id=$2,
              acknowledged_at=COALESCE(acknowledged_at, NOW())
        WHERE alert_id=$1`, [a.alert_id, team_id]);

    await client.query(
      `UPDATE field_teams SET status='en_route', current_ticket_id=$2, updated_at=NOW()
        WHERE team_id=$1`, [team_id, ticketId]);

    // the client-facing record: a crew was sent because of this alert
    if (a.property_id) {
      await client.query(`
        INSERT INTO property_events (property_id, event_type, description, metadata, created_by)
        VALUES ($1,'dispatch',$2,$3,$4)`,
        [a.property_id,
         `${tRows[0].team_name || team_id} dispatched — ${wt.replace(/_/g, ' ')}`,
         JSON.stringify({ alert_id: a.alert_id, ticket_id: ticketId, team_id, work_type: wt }),
         req.user.id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ticket_id: ticketId, alert_id: a.alert_id, team_id, work_type: wt } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /alerts/:id/dispatch', err);
    res.status(500).json({ success: false, error: 'Dispatch failed' });
  } finally {
    client.release();
  }
});

// POST /alerts/:alertId/resolve  { outcome, note? }
//   outcome: 'prevented'  -> logs incident_prevented (we caught it in time)
//            'flooded'    -> logs flood_incident (it flooded anyway — resets days-flood-free)
//            'false_alarm'-> logs nothing
router.post('/:alertId/resolve', authenticateToken, requirePermission('alerts.manage'), async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

  const { outcome, note } = req.body || {};
  const VALID = ['prevented', 'flooded', 'false_alarm'];
  if (!VALID.includes(outcome)) {
    return res.status(400).json({ success: false, error: `outcome must be one of: ${VALID.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT a.alert_id, a.sensor_id, a.status,
             COALESCE(a.property_id, sc.property_id) AS property_id
        FROM alerts a
        LEFT JOIN sentinel_coverage sc ON sc.sensor_id = a.sensor_id AND sc.is_primary
       WHERE a.alert_id = $1 FOR UPDATE OF a`, [req.params.alertId]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Alert not found' }); }
    const a = rows[0];

    await client.query(
      `UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE alert_id=$1`, [a.alert_id]);

    // free any team still tied to this alert's work order
    await client.query(`
      UPDATE field_teams SET status='idle', current_ticket_id=NULL, updated_at=NOW()
       WHERE current_ticket_id IN (SELECT ticket_id FROM tickets WHERE alert_id=$1)`, [a.alert_id]);

    const evt = outcome === 'prevented' ? 'incident_prevented'
              : outcome === 'flooded'   ? 'flood_incident' : null;
    if (evt && a.property_id) {
      await client.query(`
        INSERT INTO property_events (property_id, event_type, description, metadata, created_by)
        VALUES ($1,$2,$3,$4,$5)`,
        [a.property_id, evt,
         note || (evt === 'incident_prevented'
           ? 'Alert resolved before overflow — flooding prevented'
           : 'Flooding occurred at this property'),
         JSON.stringify({ alert_id: a.alert_id, sensor_id: a.sensor_id }), req.user.id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { alert_id: a.alert_id, outcome, event_logged: evt } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /alerts/:id/resolve', err);
    res.status(500).json({ success: false, error: 'Resolve failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
