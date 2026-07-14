// Audit logs (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// GET /audit-logs/mine — the client's own activity stream:
// their actions + any actions on their properties/tickets (e.g. ops scheduling an inspection)
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const { rows } = await pool.query(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.changes, a.created_at,
             u.full_name AS actor_name
      FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
      WHERE a.user_id = $1
         OR (a.entity_type='property' AND a.entity_id IN (SELECT property_id FROM properties WHERE user_id=$1))
         OR (a.entity_type='ticket'   AND a.entity_id IN (SELECT ticket_id FROM tickets WHERE user_id=$1))
      ORDER BY a.created_at DESC LIMIT $2`, [req.user.id, limit]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /audit-logs/mine', err); res.status(500).json({ success:false, error:'Failed to load activity' }); }
});

// GET /audit-logs?page=&limit=&action=&actor=&from=&to=  (ops only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success:false, error:'Not authorised' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { rows } = await pool.query(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.changes,
             a.ip_address, a.created_at,
             u.full_name AS actor_name, u.email AS actor_email
      FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
      ORDER BY a.created_at DESC LIMIT $1`, [limit]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /audit-logs', err); res.status(500).json({ success:false, error:'Failed to load audit logs' }); }
});

module.exports = router;
