// Field teams — ops center
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { randomUUID } = require('node:crypto');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { isClient, isSpUser, teamIdsForUser } = require('../utils/scope');

// A field technician may update the status of THEIR OWN team (en route / on site /
// returning) without the broad teams.manage permission ops managers hold.
async function canManageTeam(user, teamId) {
  if (['admin', 'super_admin'].includes(user.role)) return true;
  if (await hasPermission(user.role, 'teams.manage')) return true;
  const ids = await teamIdsForUser(user.id);
  return ids.includes(String(teamId));
}
const router = express.Router();

// This entire router manages internal field-crew assignment and live
// location; a client-portal account has no business reading or writing it.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req) || isSpUser(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
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
      WHERE u.id IN (SELECT user_id FROM team_members WHERE team_id::text = $1::text)
         OR u.team_id::text = $1::text`, [teamId]);
  return rows;
}

// GET /teams
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT field_teams.*,
      (SELECT COUNT(*)::integer FROM tickets t WHERE t.assigned_team=field_teams.team_id AND t.work_type IS NOT NULL AND t.status NOT IN ('resolved','closed','cancelled')) AS active_jobs
      FROM field_teams ORDER BY
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
    const { rows } = await pool.query(`SELECT field_teams.*,
      (SELECT COUNT(*)::integer FROM tickets t WHERE t.assigned_team=field_teams.team_id AND t.work_type IS NOT NULL AND t.status NOT IN ('resolved','closed','cancelled')) AS active_jobs
      FROM field_teams WHERE team_id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Team not found' });
    const team = rows[0];
    team.name = team.team_name;
    team.members = await membersFor(team.team_id);
    res.json({ success: true, data: team });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load team' });
  }
});

router.post('/',requirePermission('teams.manage'),async(req,res)=>{
  const b=req.body || {};
  if (typeof b.team_name!=='string' || !b.team_name.trim()) return res.status(400).json({success:false,error:'Team name required'});
  try {
    const {rows}=await pool.query(`INSERT INTO field_teams(team_id,team_name,supervisor,base_location,equipment,status)
      VALUES($1,$2,$3,$4,$5,'idle') RETURNING *`,['TEAM-'+randomUUID(),b.team_name.trim(),b.team_lead || null,b.base_location || null,b.equipment || null]);
    res.status(201).json({success:true,data:rows[0]});
  } catch(err) {res.status(500).json({success:false,error:'Failed to create team'});}
});

router.post('/:id/dispatch',requirePermission('teams.manage'),async(req,res)=>{
  const b=req.body || {};
  if (typeof b.destination!=='string' || !b.destination.trim()) return res.status(400).json({success:false,error:'Dispatch destination required'});
  if (b.eta!=null && (!Number.isInteger(Number(b.eta)) || Number(b.eta)<0)) return res.status(400).json({success:false,error:'ETA must be nonnegative minutes'});
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const t=(await db.query('SELECT * FROM field_teams WHERE team_id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if (!t) {await db.query('ROLLBACK');return res.status(404).json({success:false,error:'Team not found'});}
    if (!['idle','available','standby'].includes(t.status) || t.current_ticket_id) {await db.query('ROLLBACK');return res.status(409).json({success:false,error:'Team is not available for dispatch'});}
    if (b.alert_id) {
      const a=(await db.query('SELECT alert_id,status,assigned_team_id FROM alerts WHERE alert_id=$1 FOR UPDATE',[b.alert_id])).rows[0];
      if (!a || a.status==='resolved' || a.assigned_team_id) {await db.query('ROLLBACK');return res.status(409).json({success:false,error:'Incident is missing, resolved or already assigned'});}
      await db.query('UPDATE alerts SET assigned_team_id=$2 WHERE alert_id=$1',[b.alert_id,t.team_id]);
    }
    const {rows}=await db.query(`UPDATE field_teams SET status='en_route',dispatch_destination=$2,current_alert_id=$3,
      dispatch_eta_min=$4,dispatch_notes=$5,dispatched_at=NOW(),updated_at=NOW() WHERE team_id=$1 RETURNING *`,
      [t.team_id,b.destination.trim(),b.alert_id || null,b.eta ?? null,b.notes || null]);
    await db.query('COMMIT');res.json({success:true,data:rows[0]});
  } catch(err) {await db.query('ROLLBACK').catch(()=>{});res.status(500).json({success:false,error:'Failed to dispatch team'});}
  finally {db.release();}
});

// Recoverable archive, never cascading deletion of historical assignments.
router.delete('/:id',requireRole('admin','super_admin'),requirePermission('teams.manage'),async(req,res)=>{
  try {
    const {rows}=await pool.query(`UPDATE field_teams SET status='inactive',updated_at=NOW()
      WHERE team_id=$1 AND status IN ('idle','available','standby') AND current_ticket_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM alerts WHERE assigned_team_id=$1 AND status<>'resolved') RETURNING team_id`,[req.params.id]);
    if (!rows.length) return res.status(409).json({success:false,error:'Team is missing or has operational assignments; archive is blocked'});
    res.json({success:true,data:{archived:true,team_id:rows[0].team_id}});
  } catch(err) {res.status(500).json({success:false,error:'Failed to archive team'});}
});

// PUT /teams/:id/status  — ops managers, or a member of this team (field tech)
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    if (!(await canManageTeam(req.user, req.params.id))) {
      return res.status(403).json({ success: false, error: 'Not authorised for this team' });
    }
    const { status, location } = req.body || {};
    if (status!=null && !['idle','standby','en_route','on_site','returning','inactive'].includes(status)) return res.status(400).json({success:false,error:'Invalid team status'});
    if (status==='inactive' && !['admin','super_admin'].includes(req.user.role)) return res.status(403).json({success:false,error:'Only administrators can archive a team'});
    if (location!=null && typeof location!=='string') return res.status(400).json({success:false,error:'Location must be text'});
    const { rows } = await pool.query(
      `UPDATE field_teams SET status = COALESCE($1,status),
         current_location = COALESCE($2,current_location),
         last_checkin = NOW(), updated_at = NOW()
       WHERE team_id = $3 AND (
         $1::text IS NULL OR $1 NOT IN ('idle','standby','inactive') OR (
           current_ticket_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM alerts a WHERE a.assigned_team_id=field_teams.team_id AND a.status<>'resolved'
           )
         )
       ) RETURNING *`, [status, location, req.params.id]);
    if (!rows[0]) {
      const exists=(await pool.query('SELECT team_id FROM field_teams WHERE team_id=$1',[req.params.id])).rows.length;
      return res.status(exists ? 409 : 404).json({success:false,error:exists ? 'Resolve or release active assignments before marking the team available or archived' : 'Team not found'});
    }
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
    if (!(await pool.query("SELECT id FROM users WHERE id=$1 AND user_type='internal' AND is_active=true",[user_id])).rows.length) return res.status(400).json({success:false,error:'An active internal staff member is required'});
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
    await pool.query('UPDATE users SET team_id=NULL WHERE id=$2 AND team_id=$1',[req.params.id,req.params.userId]);
    res.json({ success: true, data: { removed: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

module.exports = router;
