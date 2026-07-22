// Team members / internal users — ops center
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireIntParam } = require('../middleware/validate-id');
const { isClient } = require('../utils/scope');
const router = express.Router();

// Roles that may exist on an internal account. Keep in sync with
// js/config.js CONFIG.NAV_ACCESS in the ops frontend.
const INTERNAL_ROLES = [
  'admin', 'super_admin', 'operations_manager', 'dispatcher',
  'field_lead', 'analyst', 'finance',
];
// Roles allowed to grant/change another account's role, or remove an account.
// This is the one place privilege escalation must be blocked.
const canManageRoles = requireRole('admin', 'super_admin');

// This entire router is the internal staff directory — a client-portal
// account has no legitimate reason to read or write any of it. Authenticate
// first (so req.user exists), then block client-role tokens outright.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// GET /users — internal team members
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id AS user_id, u.id, u.full_name, u.email, u.role, u.user_type,
             u.phone, u.team_id, u.last_login,
             CASE WHEN u.is_active THEN 'active' ELSE 'inactive' END AS status,
             u.created_at
      FROM users u
      WHERE u.user_type = 'internal'
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /users', err);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
});

// GET /roles
router.get('/roles', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT role_id, role_name, permissions FROM roles ORDER BY role_id');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load roles' });
  }
});

// GET /users/:id
router.get('/:id', authenticateToken, requireIntParam('id'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, id AS user_id, full_name, email, role, user_type, phone, team_id,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status, last_login
       FROM users WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// POST /users/invite — admin/super_admin only: this mints a new internal
// login, so it's the single highest-value privilege-escalation target in
// the app if left open.
router.post('/invite', authenticateToken, canManageRoles, requirePermission('team-members.manage'), async (req, res) => {
  try {
    const { email, full_name, role } = req.body || {};
    const roleVal = role || req.body.role_id;
    if (!email || !full_name) return res.status(400).json({ success: false, error: 'Email and full name required' });
    if (roleVal && !INTERNAL_ROLES.includes(roleVal)) {
      return res.status(400).json({ success: false, error: `role must be one of: ${INTERNAL_ROLES.join(', ')}` });
    }
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (exists.rows.length) return res.status(409).json({ success: false, error: 'User already exists' });
    // A random placeholder password — the invitee never uses it; they set their
    // own via the emailed link below. crypto, not Math.random: it's still a real
    // credential until overwritten.
    const temp = crypto.randomBytes(18).toString('base64url');
    const hash = await bcrypt.hash(temp, 10);
    const finalRole = roleVal || 'analyst';
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, user_type, is_active, email_verified)
       VALUES ($1,$2,$3,$4,'internal',true,false) RETURNING id, email, full_name, role`,
      [email.toLowerCase().trim(), hash, full_name, finalRole]);
    const newUser = rows[0];

    // ── Role-based invite email ──────────────────────────────────────────
    // Field technicians (field_lead) live in the Field Operations app; everyone
    // else in the Operations Center. We mint a set-password link (same mechanism
    // as password reset) valid for 7 days, so no plaintext credential is emailed.
    const OPS_HOST = process.env.OPS_PORTAL_URL || 'https://neon.flowguard.ng';
    const FIELD_ROLES = ['field_lead', 'field_team'];
    const isField = FIELD_ROLES.includes(finalRole);
    const portal = isField
      ? { name: 'FlowGuard Field Operations', loginUrl: `${OPS_HOST}/field.html` }
      : { name: 'FlowGuard Operations Center', loginUrl: `${OPS_HOST}/login.html` };
    const roleLabel = String(finalRole).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days for invites
    await pool.query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [tokenHash, expires, newUser.id]);
    const setupUrl = `${OPS_HOST}/reset-password.html?token=${inviteToken}`;

    let emailed = false;
    try {
      await require('../utils/mailer').sendStaffInvite(newUser.email, {
        fullName: newUser.full_name, roleLabel,
        portalName: portal.name, portalUrl: portal.loginUrl, setupUrl,
        inviterName: req.user.full_name || req.user.email,
      });
      emailed = true;
    } catch (e) { console.error('[invite] email error:', e.message); }

    res.status(201).json({ success: true, data: { ...newUser, invited: true, emailed } });
  } catch (err) {
    console.error('POST /users/invite', err);
    res.status(500).json({ success: false, error: 'Failed to invite user' });
  }
});

// PUT /users/:id — any internal (non-client) account may update a colleague's
// contact details, but changing role or active-state is a privilege change
// and is restricted to admin/super_admin.
router.put('/:id', authenticateToken, requireIntParam('id'), requirePermission('team-members.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const changesPrivilege = ['role', 'role_id', 'status', 'is_active'].some(k => k in body);
    if (changesPrivilege && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only an admin can change role or account status' });
    }
    if (('role' in body || 'role_id' in body)) {
      const roleVal = body.role || body.role_id;
      if (!INTERNAL_ROLES.includes(roleVal)) {
        return res.status(400).json({ success: false, error: `role must be one of: ${INTERNAL_ROLES.join(', ')}` });
      }
    }
    const map = { full_name:'full_name', role:'role', role_id:'role', is_active:'is_active', phone:'phone', team_id:'team_id' };
    // Collect column→value in a map so aliases that target the SAME column
    // (status + is_active, role + role_id) collapse to one SET clause. Sending
    // both — as the Deactivate button does ({is_active:false, status:'inactive'})
    // — previously produced "SET is_active=$1, is_active=$2" → a 500.
    const cols = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'status') { cols.is_active = (v === 'active'); continue; }
      if (map[k]) cols[map[k]] = v;
    }
    const entries = Object.entries(cols);
    if (!entries.length) return res.status(400).json({ success: false, error: 'No valid fields' });
    const sets = entries.map(([c], idx) => `${c} = $${idx + 1}`);
    const vals = entries.map(([, v]) => v);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING id, email, full_name, role`, vals);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /users/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// DELETE /users/:id — admin/super_admin only.
// A staff account is referenced across the app (reports authored, tickets,
// inspections, assignments, audit trail). A bare DELETE hit those foreign keys
// and 500'd. We remove the app-owned dependents that shouldn't block removal,
// then delete; if history still references the account we surface a clean 409
// telling the admin to deactivate instead — never a 500.
router.delete('/:id', authenticateToken, canManageRoles, requireIntParam('id'), requirePermission('team-members.manage'), async (req, res) => {
  const id = req.params.id;
  if (String(req.user.id) === String(id)) {
    return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // dependents the app owns and that carry no historical value
    await client.query('DELETE FROM team_members   WHERE user_id = $1', [id]);
    await client.query('DELETE FROM notifications   WHERE user_id = $1', [id]);
    await client.query('DELETE FROM user_preferences WHERE user_id = $1', [id]);
    const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [id]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'User not found' }); }
    await client.query('COMMIT');
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') {   // FK violation — account has historical records
      return res.status(409).json({ success: false,
        error: 'This member has linked records (reports, tickets or assignments) and can\'t be deleted. Deactivate them instead.' });
    }
    console.error('DELETE /users/:id', err);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  } finally {
    client.release();
  }
});

module.exports = router;
