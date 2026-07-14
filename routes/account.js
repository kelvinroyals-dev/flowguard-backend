// Client account management: profile, password, preferences, deactivate/delete
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

function publicUser(u) {
  return { id:u.id, email:u.email, role:u.role, user_type:u.user_type,
           fullName:u.full_name, full_name:u.full_name, phone:u.phone, client_id:u.client_id };
}

// GET /profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'User not found' });
    res.json({ success:true, data:{ user: publicUser(rows[0]) } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load profile' }); }
});

// PUT /profile   body: { fullName, email, phone, organization }
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, phone } = req.body || {};
    const sets = [], vals = []; let i = 1;
    if (fullName !== undefined) { sets.push(`full_name = $${i++}`); vals.push(fullName); }
    if (phone !== undefined)    { sets.push(`phone = $${i++}`);     vals.push(phone); }
    // email change intentionally ignored (identity); organization not a user column
    if (!sets.length) return res.status(400).json({ success:false, error:'No valid fields' });
    vals.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i} RETURNING *`, vals);
    res.json({ success:true, data:{ user: publicUser(rows[0]) } });
  } catch (err) { console.error('PUT /profile', err); res.status(500).json({ success:false, error:'Failed to update profile' }); }
});

// PUT /password   body: { currentPassword, newPassword }
router.put('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ success:false, error:'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ success:false, error:'New password must be at least 8 characters' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ success:false, error:'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    res.json({ success:true, data:{ changed:true } });
  } catch (err) { console.error('PUT /password', err); res.status(500).json({ success:false, error:'Failed to change password' }); }
});

// GET /preferences
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    let { rows } = await pool.query('SELECT * FROM user_preferences WHERE user_id=$1', [req.user.id]);
    if (!rows[0]) {
      const ins = await pool.query('INSERT INTO user_preferences (user_id) VALUES ($1) RETURNING *', [req.user.id]);
      rows = ins.rows;
    }
    res.json({ success:true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load preferences' }); }
});

// PUT /preferences
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const allowed = ['show_demo_data','onboarding_completed','onboarding_step','onboarding_skipped',
                     'preferred_language','timezone','notification_preferences'];
    const sets = [], vals = []; let i = 1;
    for (const k of allowed) if (k in (req.body||{})) {
      sets.push(`${k} = $${i++}`);
      vals.push(k === 'notification_preferences' ? JSON.stringify(req.body[k]) : req.body[k]);
    }
    if (!sets.length) return res.status(400).json({ success:false, error:'No valid fields' });
    vals.push(req.user.id);
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id) VALUES ($${i})
       ON CONFLICT (user_id) DO UPDATE SET ${sets.join(', ')}, updated_at=NOW() RETURNING *`, vals);
    res.json({ success:true, data: rows[0] });
  } catch (err) { console.error('PUT /preferences', err); res.status(500).json({ success:false, error:'Failed to update preferences' }); }
});

// POST /account/deactivate
router.post('/account/deactivate', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_active=false, updated_at=NOW() WHERE id=$1', [req.user.id]);
    res.json({ success:true, data:{ deactivated:true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to deactivate account' }); }
});

// DELETE /account
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    res.json({ success:true, data:{ deleted:true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to delete account' }); }
});

module.exports = router;
