// Field teams — ops center
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

async function membersFor(teamId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, tm.role AS team_role
     FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1`, [teamId]);
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

// PUT /teams/:id/status
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
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
router.post('/:id/members', authenticateToken, async (req, res) => {
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
router.delete('/:id/members/:userId', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',
      [req.params.id, req.params.userId]);
    res.json({ success: true, data: { removed: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

module.exports = router;
