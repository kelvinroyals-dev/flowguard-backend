// Inspections — read + field-agent completion.
// Inspections previously had no router of their own (only reachable through
// properties.js), so the field portal's GET /inspections and PUT /inspections/:id
// both 404'd. This exposes exactly what the field portal needs, scoped so a
// technician only ever sees/acts on their OWN team's inspections unless they
// hold the broad maintenance.manage permission.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { hasPermission } = require('../utils/permissions');
const { isClient, teamIdsForUser } = require('../utils/scope');
const realtime = require('../realtime/io');

const router = express.Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// Teams (id + name) the caller belongs to — assigned_team may hold either.
async function callerTeams(userId) {
  const ids = await teamIdsForUser(userId);
  if (!ids.length) return { ids: [], names: [] };
  const { rows } = await pool.query(
    `SELECT team_id, team_name FROM field_teams WHERE team_id::text = ANY($1)`, [ids]);
  return { ids, names: rows.map(r => r.team_name).filter(Boolean) };
}

async function isManager(user) {
  return ['admin', 'super_admin'].includes(user.role) || await hasPermission(user.role, 'maintenance.manage');
}

// GET /inspections  — managers see all; field agents see only their team's.
router.get('/', async (req, res) => {
  try {
    const mgr = await isManager(req.user);
    const base = `
      SELECT i.inspection_id, i.property_id, i.status, i.assigned_team,
             i.scheduled_date, i.findings, i.recommendations, i.created_at, i.updated_at,
             p.property_name, p.address_line1, p.city, p.state,
             p.contact_person_name, p.contact_phone
        FROM inspections i
        LEFT JOIN properties p ON p.property_id = i.property_id`;
    let rows;
    if (mgr) {
      ({ rows } = await pool.query(base + ` ORDER BY i.scheduled_date NULLS LAST, i.created_at DESC`));
    } else {
      const { ids, names } = await callerTeams(req.user.id);
      if (!ids.length) return res.json({ success: true, data: [] });
      ({ rows } = await pool.query(
        base + ` WHERE i.assigned_team::text = ANY($1) OR i.assigned_team::text = ANY($2)
                 ORDER BY i.scheduled_date NULLS LAST, i.created_at DESC`,
        [ids, names]));
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /inspections', err);
    res.status(500).json({ success: false, error: 'Failed to load inspections' });
  }
});

// PUT /inspections/:id  body: { status?, findings?, recommendations? }
// Allowed for a member of the inspection's assigned team, or maintenance.manage.
router.put('/:id', async (req, res) => {
  try {
    const { rows: found } = await pool.query(
      `SELECT inspection_id, assigned_team FROM inspections WHERE inspection_id = $1`, [req.params.id]);
    if (!found[0]) return res.status(404).json({ success: false, error: 'Inspection not found' });

    if (!(await isManager(req.user))) {
      const { ids, names } = await callerTeams(req.user.id);
      const at = found[0].assigned_team != null ? String(found[0].assigned_team) : null;
      const mine = at && (ids.includes(at) || names.includes(at));
      if (!mine) return res.status(403).json({ success: false, error: 'This inspection is not assigned to your team' });
    }

    const { status, findings, recommendations } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE inspections
          SET status = COALESCE($1, status),
              findings = COALESCE($2, findings),
              recommendations = COALESCE($3, recommendations),
              updated_at = NOW()
        WHERE inspection_id = $4 RETURNING *`,
      [status || null, findings || null, recommendations || null, req.params.id]);

    // keep the property pipeline in step when an inspection is completed
    if (status === 'completed') {
      await pool.query(
        `UPDATE properties SET status = 'report_ready', updated_at = NOW()
          WHERE property_id = $1 AND status IN ('inspection_scheduled','inspection_ongoing')`,
        [rows[0].property_id]).catch(() => {});
    }
    if (realtime.events && realtime.events.inspectionUpdated) realtime.events.inspectionUpdated(rows[0]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /inspections/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update inspection' });
  }
});

module.exports = router;
