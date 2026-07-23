// routes/clientTeam.js — client-portal team & role management.
// An account is an organisation: the owner (account_owner_id IS NULL) plus the
// members grouped under them. Only holders of `manage_team` (platform_admin) can
// invite / change roles / deactivate. All actions are scoped to the caller's own
// organisation — a client can never touch another org's users.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
  CLIENT_ROLES, isValidClientRole, requireClientPermission, clientRoleInfo,
} = require('../utils/clientPermissions');

const router = express.Router();

const APP_HOST = 'https://app.flowguard.ng';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const ownerIdOf = u => u.account_owner_id || u.id;

// The JWT only carries id/email/role/user_type. Load the full row so
// account_owner_id + client_role are available for scoping and permission checks
// (without this, owner-detection would treat every client as an admin).
async function loadClientUser(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, company, user_type, account_owner_id, client_role FROM users WHERE id=$1',
      [req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    if (rows[0].user_type !== 'client') return res.status(403).json({ success: false, error: 'Client accounts only' });
    req.user = { ...req.user, ...rows[0] };
    next();
  } catch (e) { console.error('loadClientUser', e); res.status(500).json({ success: false, error: 'Failed to load account' }); }
}

router.use(authenticateToken, loadClientUser);

function memberView(row, meId) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    client_role: row.account_owner_id == null ? 'platform_admin' : (row.client_role || 'member'),
    client_role_label: (CLIENT_ROLES[row.account_owner_id == null ? 'platform_admin' : (row.client_role || 'member')] || {}).label || '—',
    is_account_owner: row.account_owner_id == null,
    is_active: row.is_active !== false,
    is_you: row.id === meId,
    invited_pending: !row.email_verified && row.account_owner_id != null,
  };
}

// GET /client-team/roles — role catalogue for the invite/assign dropdowns.
router.get('/roles', (req, res) => {
  res.json({ success: true, data: Object.entries(CLIENT_ROLES).map(([key, r]) => ({ key, label: r.label, desc: r.desc })) });
});

// GET /client-team/me — the caller's own role + permissions (FE gating).
router.get('/me', (req, res) => {
  res.json({ success: true, data: clientRoleInfo(req.user) });
});

// GET /client-team — the organisation roster. Any member may view it.
router.get('/', async (req, res) => {
  try {
    const oid = ownerIdOf(req.user);
    const { rows } = await pool.query(
      `SELECT id, full_name, email, account_owner_id, client_role, is_active, email_verified
         FROM users
        WHERE user_type='client' AND (id=$1 OR account_owner_id=$1)
        ORDER BY (account_owner_id IS NULL) DESC, full_name ASC`, [oid]);
    res.json({ success: true, data: rows.map(r => memberView(r, req.user.id)) });
  } catch (e) { console.error('GET /client-team', e); res.status(500).json({ success: false, error: 'Failed to load team' }); }
});

// POST /client-team/invite  { email, full_name, client_role }
router.post('/invite', requireClientPermission('manage_team'), async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const fullName = String((req.body && req.body.full_name) || '').trim();
  const role = String((req.body && req.body.client_role) || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, error: 'A valid email is required' });
  if (!fullName) return res.status(400).json({ success: false, error: 'Name is required' });
  if (!isValidClientRole(role)) return res.status(400).json({ success: false, error: 'Invalid role' });
  try {
    const exists = (await pool.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0];
    if (exists) return res.status(409).json({ success: false, error: 'A user with that email already exists' });

    const oid = ownerIdOf(req.user);
    const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, role, user_type, full_name, account_owner_id, client_role, is_active, email_verified)
       VALUES ($1,$2,'client','client',$3,$4,$5,true,false)
       RETURNING id, email, full_name, account_owner_id, client_role, is_active, email_verified`,
      [email, placeholder, fullName, oid, role]);
    const member = ins.rows[0];

    // Set-password link (same mechanism as ops invites): store a hashed token.
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [sha256(token), expires, member.id]);

    let emailed = false;
    try {
      const orgRow = (await pool.query('SELECT company, full_name FROM users WHERE id=$1', [oid])).rows[0] || {};
      await require('../utils/mailer').sendClientInvite(email, {
        fullName,
        roleLabel: (CLIENT_ROLES[role] || {}).label || role,
        orgName: orgRow.company || orgRow.full_name || 'your FlowGuard account',
        setupUrl: `${APP_HOST}/reset-password.html?token=${token}&invite=1`,
        inviterName: req.user.full_name || req.user.email,
      });
      emailed = true;
    } catch (e) { console.error('[client-team invite] email error:', e.message); }

    res.status(201).json({ success: true, data: { ...memberView(member, req.user.id), emailed } });
  } catch (e) { console.error('POST /client-team/invite', e); res.status(500).json({ success: false, error: 'Failed to invite teammate' }); }
});

// Resolve a target user that MUST belong to the caller's org (never cross-org).
async function fetchOrgMember(req, id) {
  const oid = ownerIdOf(req.user);
  const { rows } = await pool.query(
    `SELECT id, full_name, email, account_owner_id, client_role, is_active, email_verified
       FROM users WHERE id=$1 AND user_type='client' AND (id=$2 OR account_owner_id=$2)`, [id, oid]);
  return rows[0] || null;
}

// PUT /client-team/:id/role  { client_role }
router.put('/:id/role', requireClientPermission('manage_team'), async (req, res) => {
  const role = String((req.body && req.body.client_role) || '').trim();
  if (!isValidClientRole(role)) return res.status(400).json({ success: false, error: 'Invalid role' });
  try {
    const m = await fetchOrgMember(req, req.params.id);
    if (!m) return res.status(404).json({ success: false, error: 'Teammate not found in your account' });
    if (m.account_owner_id == null) return res.status(400).json({ success: false, error: "The account owner's role can't be changed" });
    if (m.id === req.user.id) return res.status(400).json({ success: false, error: "You can't change your own role" });
    const { rows } = await pool.query(
      'UPDATE users SET client_role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, full_name, email, account_owner_id, client_role, is_active, email_verified',
      [role, m.id]);
    res.json({ success: true, data: memberView(rows[0], req.user.id) });
  } catch (e) { console.error('PUT /client-team/:id/role', e); res.status(500).json({ success: false, error: 'Failed to update role' }); }
});

// PUT /client-team/:id/status  { is_active }
router.put('/:id/status', requireClientPermission('manage_team'), async (req, res) => {
  const active = !!(req.body && req.body.is_active);
  try {
    const m = await fetchOrgMember(req, req.params.id);
    if (!m) return res.status(404).json({ success: false, error: 'Teammate not found in your account' });
    if (m.account_owner_id == null) return res.status(400).json({ success: false, error: "The account owner can't be deactivated" });
    if (m.id === req.user.id) return res.status(400).json({ success: false, error: "You can't deactivate yourself" });
    const { rows } = await pool.query(
      'UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, full_name, email, account_owner_id, client_role, is_active, email_verified',
      [active, m.id]);
    res.json({ success: true, data: memberView(rows[0], req.user.id) });
  } catch (e) { console.error('PUT /client-team/:id/status', e); res.status(500).json({ success: false, error: 'Failed to update status' }); }
});

module.exports = router;
