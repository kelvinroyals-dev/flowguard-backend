// Clients (activated paying sites) — ops center
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requireIntParam } = require('../middleware/validate-id');
const { isClient } = require('../utils/scope');
const router = express.Router();

// This is the customer directory — a client account has no business
// browsing or editing every other customer's record.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// GET /clients — client-type USERS who submitted areas (ops "Clients" tab)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id AS client_id, u.id, u.full_name, u.email, u.phone,
             CASE WHEN u.is_active THEN 'active' ELSE 'inactive' END AS status,
             u.is_active, u.created_at,
             COUNT(p.id)                                              AS submitted_areas,
             COUNT(p.id) FILTER (WHERE p.status IN
               ('submitted','inspection_scheduled','inspection_ongoing',
                'report_ready','quote_sent','payment_pending'))       AS pending_areas,
             COUNT(p.id) FILTER (WHERE p.status = 'active')           AS active_areas
      FROM users u
      LEFT JOIN properties p ON p.user_id = u.id
      WHERE u.user_type = 'client'
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /clients', err);
    res.status(500).json({ success: false, error: 'Failed to load clients' });
  }
});

// GET /clients/:id — a client USER with their submitted areas + invoices
router.get('/:id', authenticateToken, requireIntParam('id'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, id AS client_id, full_name, email, phone,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status,
              is_active, created_at, last_login
       FROM users WHERE id = $1 AND user_type = 'client'`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Client not found' });
    const client = rows[0];
    const areas = await pool.query(
      `SELECT property_id, property_name, property_type, city, state, status, created_at
       FROM properties WHERE user_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    const invoices = await pool.query(
      `SELECT invoice_id, invoice_type, total_amount, payment_status, due_date, created_at
       FROM invoices WHERE user_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    client.areas = areas.rows;
    client.invoices = invoices.rows;
    res.json({ success: true, data: client });
  } catch (err) {
    console.error('GET /clients/:id', err);
    res.status(500).json({ success: false, error: 'Failed to load client' });
  }
});

// PUT /clients/:id — update a client user. Editing another customer's
// account (including deactivating it) is an admin/ops-manager/finance action.
router.put('/:id', authenticateToken, requireRole('admin', 'super_admin', 'operations_manager', 'finance'), requireIntParam('id'), async (req, res) => {
  try {
    const sets = [], vals = []; let i = 1;
    if ('full_name' in req.body) { sets.push(`full_name = $${i++}`); vals.push(req.body.full_name); }
    if ('phone' in req.body)     { sets.push(`phone = $${i++}`);     vals.push(req.body.phone); }
    if ('status' in req.body)    { sets.push(`is_active = $${i++}`); vals.push(req.body.status === 'active'); }
    if ('is_active' in req.body) { sets.push(`is_active = $${i++}`); vals.push(req.body.is_active); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No valid fields' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${i} AND user_type='client' RETURNING id, full_name, email, phone`, vals);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Client not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /clients/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update client' });
  }
});

// DELETE /clients/:id — delete a client user (cascades to their properties).
// Destructive + cascading: admin/super_admin only.
router.delete('/:id', authenticateToken, requireRole('admin', 'super_admin'), requireIntParam('id'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM users WHERE id = $1 AND user_type='client'`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Client not found' });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    console.error('DELETE /clients/:id', err);
    res.status(500).json({ success: false, error: 'Failed to delete client' });
  }
});

module.exports = router;
