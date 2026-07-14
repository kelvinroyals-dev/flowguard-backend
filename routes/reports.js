// Reports — generated analytics reports
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const router = express.Router();

// Company-wide analytics reports (across all clients) — ops only.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// GET /reports
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.report_id, r.report_id AS id, r.report_type AS type, r.report_type AS name,
             r.period_start, r.period_end, r.metrics, r.file_url, r.generated_at,
             u.full_name AS generated_by_name, c.name AS client_name
      FROM reports r LEFT JOIN users u ON r.generated_by=u.id
      LEFT JOIN clients c ON r.client_id=c.id
      ORDER BY r.generated_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /reports', err); res.status(500).json({ success:false, error:'Failed to load reports' }); }
});

// POST /reports/generate  body: { type }
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { type } = req.body || {};
    const reportId = 'RPT-' + Date.now() + '-' + Math.floor(Math.random()*900+100);
    const { rows } = await pool.query(
      `INSERT INTO reports (report_id, report_type, generated_by, period_start, period_end, metrics)
       VALUES ($1,$2,$3, date_trunc('month',CURRENT_DATE), CURRENT_DATE, '{}'::jsonb) RETURNING *`,
      [reportId, type || 'daily', req.user.id]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST /reports/generate', err); res.status(500).json({ success:false, error:'Failed to generate report' }); }
});

module.exports = router;
