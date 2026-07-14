// Team members / internal users — ops center
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
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
router.post('/invite', authenticateToken, canManageRoles, async (req, res) => {
  try {
    const { email, full_name, role } = req.body || {};
    const roleVal = role || req.body.role_id;
    if (!email || !full_name) return res.status(400).json({ success: false, error: 'Email and full name required' });
    if (roleVal && !INTERNAL_ROLES.includes(roleVal)) {
      return res.status(400).json({ success: false, error: `role must be one of: ${INTERNAL_ROLES.join(', ')}` });
    }
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (exists.rows.length) return res.status(409).json({ success: false, error: 'User already exists' });
    // crypto.randomBytes, not Math.random — this is a real credential, however temporary.
    const temp = crypto.randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(temp, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, user_type, is_active, email_verified)
       VALUES ($1,$2,$3,$4,'internal',true,false) RETURNING id, email, full_name, role`,
      [email.toLowerCase().trim(), hash, full_name, roleVal || 'analyst']);
    res.status(201).json({ success: true, data: { ...rows[0], tempPassword: temp } });
  } catch (err) {
    console.error('POST /users/invite', err);
    res.status(500).json({ success: false, error: 'Failed to invite user' });
  }
});

// PUT /users/:id — any internal (non-client) account may update a colleague's
// contact details, but changing role or active-state is a privilege change
// and is restricted to admin/super_admin.
router.put('/:id', authenticateToken, requireIntParam('id'), async (req, res) => {
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
    const map = { full_name:'full_name', role:'role', role_id:'role', status:null, is_active:'is_active', phone:'phone', team_id:'team_id' };
    const sets = [], vals = []; let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (k === 'status') { sets.push(`is_active = $${i++}`); vals.push(v === 'active'); continue; }
      if (map[k]) { sets.push(`${map[k]} = $${i++}`); vals.push(v); }
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No valid fields' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i} RETURNING id, email, full_name, role`, vals);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /users/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// DELETE /users/:id — admin/super_admin only.
router.delete('/:id', authenticateToken, canManageRoles, requireIntParam('id'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

module.exports = router;
