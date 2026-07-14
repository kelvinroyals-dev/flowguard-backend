// SLA tracking (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// GET /sla/summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const agg = await pool.query(`
      SELECT COALESCE(AVG(uptime_percentage),100) compliance,
             COALESCE(AVG(avg_response_time_min),0) avg_resp,
             COALESCE(SUM(incidents_total),0) incidents
      FROM sla_tracking WHERE month >= date_trunc('month', CURRENT_DATE)`);
    const breaches = await pool.query(`
      SELECT COUNT(*) c FROM sla_tracking
      WHERE month >= date_trunc('month', CURRENT_DATE) AND jsonb_array_length(COALESCE(sla_breaches,'[]'::jsonb)) > 0`);
    // per-client rollup
    const clients = await pool.query(`
      SELECT c.name AS client_name, c.id AS client_id,
             COALESCE(AVG(s.uptime_percentage),100) AS uptime,
             COALESCE(SUM(jsonb_array_length(COALESCE(s.sla_breaches,'[]'::jsonb))),0) AS breaches
      FROM clients c LEFT JOIN sla_tracking s ON s.client_id=c.id
      GROUP BY c.id, c.name ORDER BY uptime ASC`);
    const a = agg.rows[0];
    res.json({ success: true, data: {
      overall_compliance: +(parseFloat(a.compliance)||100).toFixed(1),
      avg_response_min: Math.round(parseFloat(a.avg_resp)||0),
      breaches_this_month: parseInt(breaches.rows[0].c)||0,
      incidents_this_month: parseInt(a.incidents)||0,
      clients: clients.rows,
    }});
  } catch (err) { console.error('GET /sla/summary', err); res.status(500).json({ success:false, error:'Failed to load SLA summary' }); }
});

// GET /sla/breaches — derive from sla_tracking breach arrays
router.get('/breaches', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id AS breach_id, s.id, c.name AS client_name, s.month,
             s.uptime_percentage, s.total_penalty, s.sla_breaches,
             NULL::timestamp AS acknowledged_at
      FROM sla_tracking s LEFT JOIN clients c ON s.client_id=c.id
      WHERE jsonb_array_length(COALESCE(s.sla_breaches,'[]'::jsonb)) > 0
      ORDER BY s.month DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /sla/breaches', err); res.status(500).json({ success:false, error:'Failed to load breaches' }); }
});

// POST /sla/breaches/:id/acknowledge
router.post('/breaches/:id/acknowledge', authenticateToken, async (req, res) => {
  try {
    // store ack in the row's breach json meta (lightweight)
    await pool.query(
      `UPDATE sla_tracking SET sla_breaches = jsonb_set(COALESCE(sla_breaches,'[]'::jsonb),
        '{0,acknowledged_at}', to_jsonb(NOW()::text), true) WHERE id=$1`, [req.params.id]);
    res.json({ success: true, data: { acknowledged: true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to acknowledge breach' }); }
});

module.exports = router;
