// Field teams — ops center
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { isClient, teamIdsForUser } = require('../utils/scope');

// A field technician may update the status of THEIR OWN team (en route / on site /
// returning) without the broad teams.manage permission ops managers hold.
async function canManageTeam(user, teamId) {
  if (['admin', 'super_admin'].includes(user.role)) return true;
  if (await hasPermission(user.role, 'teams.manage')) return true;
  const ids = await teamIdsForUser(user.id);
  return ids.includes(teamId);
}
const router = express.Router();

// This entire router manages internal field-crew assignment and live
// location; a client-portal account has no business reading or writing it.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

async function membersFor(teamId) {
  // Include members recorded either way: in team_members OR via the denormalised
  // users.team_id. Otherwise a technician assigned before team_members was kept
  // in sync wouldn't show on the crew — and the field portal (which finds a
  // technician's team through this list) would report "no team" for them.
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role,
            (SELECT tm.role FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id = $1 LIMIT 1) AS team_role
       FROM users u
      WHERE u.id IN (SELECT user_id FROM team_members WHERE team_id = $1)
         OR u.team_id = $1`, [teamId]);
  return rows;
}

// GET /teams
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM field_teams ORDER BY
      CASE status WHEN 'on_site' THEN 1 WHEN 'en_route' THEN 2 ELSE 3 END, team_id`);
    for (const t of rows) {
      t.members = await membersFor(t.team_id);
      t.name = t.team_name;          // frontend reads team_name||name
      t.current_location = t.current_location;
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /teams', err);
    res.status(500).json({ success: false, error: 'Failed to load teams' });
  }
});

// GET /teams/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM field_teams WHERE team_id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Team not found' });
    const team = rows[0];
    team.name = team.team_name;
    team.members = await membersFor(team.team_id);
    res.json({ success: true, data: team });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load team' });
  }
});

// PUT /teams/:id/status  — ops managers, or a member of this team (field tech)
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    if (!(await canManageTeam(req.user, req.params.id))) {
      return res.status(403).json({ success: false, error: 'Not authorised for this team' });
    }
    const { status, location } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE field_teams SET status = COALESCE($1,status),
         current_location = COALESCE($2,current_location),
         last_checkin = NOW(), updated_at = NOW()
       WHERE team_id = $3 RETURNING *`, [status, location, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Team not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update team' });
  }
});

// POST /teams/:id/members  body: { user_id, team_role }
router.post('/:id/members', authenticateToken, requirePermission('teams.manage'), async (req, res) => {
  try {
    const { user_id, team_role } = req.body || {};
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.id, user_id, team_role || null]);
    res.status(201).json({ success: true, data: { added: true } });
  } catch (err) {
    console.error('POST /teams/:id/members', err);
    res.status(500).json({ success: false, error: 'Failed to add member' });
  }
});

// DELETE /teams/:id/members/:userId
router.delete('/:id/members/:userId', authenticateToken, requirePermission('teams.manage'), async (req, res) => {
  try {
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',
      [req.params.id, req.params.userId]);
    res.json({ success: true, data: { removed: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

module.exports = router;
