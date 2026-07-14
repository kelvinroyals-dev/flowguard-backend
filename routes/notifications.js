// Notifications (client + ops)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// GET /notifications — current user's
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT notification_id, notification_id AS id, title, message, type,
              is_read, is_read AS read, link, created_at
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /notifications', err); res.status(500).json({ success:false, error:'Failed to load notifications' }); }
});

// PUT /notifications/:id/read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read=true, read_at=NOW()
       WHERE notification_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    res.json({ success: true, data: { read: true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to mark read' }); }
});

// PUT /notifications/read-all
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read=true, read_at=NOW() WHERE user_id=$1 AND is_read=false`, [req.user.id]);
    res.json({ success: true, data: { read: true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to mark all read' }); }
});

// DELETE /notifications/:id
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM notifications WHERE notification_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to delete notification' }); }
});

module.exports = router;
