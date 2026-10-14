// SLA tracking (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient, isSpUser } = require('../utils/scope');
const { requireIntParam } = require('../middleware/validate-id');
const { requirePermission } = require('../utils/permissions');
const router = express.Router();

// Per-client SLA/uptime rollups across the whole company — ops only.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req) || isSpUser(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});
router.use(requirePermission('sla.view'));

// GET /sla/summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const agg = await pool.query(`
      SELECT AVG(uptime_percentage) FILTER (WHERE uptime_percentage BETWEEN 0 AND 100) uptime,
             AVG(avg_response_time_min) FILTER (WHERE avg_response_time_min >= 0) avg_resp,
             SUM(incidents_total) FILTER (WHERE incidents_total >= 0) incidents,
             COUNT(*)::integer record_count,
             date_trunc('month',CURRENT_DATE)::date::text period_start,
             (date_trunc('month',CURRENT_DATE)+INTERVAL '1 month')::date::text period_end_exclusive
      FROM sla_tracking WHERE month >= date_trunc('month', CURRENT_DATE)
        AND month < date_trunc('month',CURRENT_DATE)+INTERVAL '1 month'`);
    const breaches = await pool.query(`
      SELECT COALESCE(SUM(jsonb_array_length(COALESCE(sla_breaches,'[]'::jsonb))),0)::integer c FROM sla_tracking
      WHERE month >= date_trunc('month', CURRENT_DATE)
        AND month < date_trunc('month',CURRENT_DATE)+INTERVAL '1 month'`);
    // per-client rollup
    const clients = await pool.query(`
      SELECT c.name AS client_name, c.id AS client_id,
             AVG(s.uptime_percentage) FILTER (WHERE s.uptime_percentage BETWEEN 0 AND 100) AS uptime,
             AVG(s.avg_response_time_min) FILTER (WHERE s.avg_response_time_min >= 0) AS avg_response_min,
             COUNT(s.id)::integer AS record_count,
             COALESCE(SUM(jsonb_array_length(COALESCE(s.sla_breaches,'[]'::jsonb))),0) AS breaches
      FROM clients c LEFT JOIN sla_tracking s ON s.client_id=c.id
        AND s.month >= date_trunc('month',CURRENT_DATE)
        AND s.month < date_trunc('month',CURRENT_DATE)+INTERVAL '1 month'
      GROUP BY c.id, c.name ORDER BY uptime ASC NULLS LAST,c.id`);
    const a = agg.rows[0];
    const number = v => v == null ? null : Number(v);
    const period = {start:a.period_start,end_exclusive:a.period_end_exclusive};
    res.json({ success: true, data: {
      overall_compliance: null, overall_uptime:number(a.uptime),
      avg_response_min: number(a.avg_resp),
      breaches_this_month: parseInt(breaches.rows[0].c)||0,
      incidents_this_month: number(a.incidents),
      resolved_on_time:null,eligible_count:null,record_count:a.record_count,reporting_period:period,
      metric_basis:'Unweighted mean of recorded monthly aggregates; not event-weighted contractual compliance.',
      clients: clients.rows.map(c=>({...c,uptime:number(c.uptime),avg_response_min:number(c.avg_response_min),reporting_period:period,eligible_count:null})),
    }});
  } catch (err) { console.error('GET /sla/summary', err); res.status(500).json({ success:false, error:'Failed to load SLA summary' }); }
});

// GET /sla/breaches — derive from sla_tracking breach arrays
router.get('/breaches', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id AS breach_id, s.id, s.client_id, c.name AS client_name, s.month,
             s.uptime_percentage, s.total_penalty, s.sla_breaches,
             jsonb_array_length(COALESCE(s.sla_breaches,'[]'::jsonb)) AS breach_count,
             s.acknowledged_at,s.acknowledged_by,u.full_name AS acknowledged_by_name
      FROM sla_tracking s LEFT JOIN clients c ON s.client_id=c.id
      LEFT JOIN users u ON u.id=s.acknowledged_by
      WHERE jsonb_array_length(COALESCE(s.sla_breaches,'[]'::jsonb)) > 0
      ORDER BY s.month DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /sla/breaches', err); res.status(500).json({ success:false, error:'Failed to load breaches' }); }
});

// POST /sla/breaches/:id/acknowledge
router.post('/breaches/:id/acknowledge', requireIntParam(), requirePermission('sla.manage'), async (req, res) => {
  try {
    // Review of the aggregate does not resolve incidents or amend breach evidence.
    const {rows}=await pool.query(
      `UPDATE sla_tracking SET acknowledged_at=COALESCE(acknowledged_at,NOW()),
        acknowledged_by=COALESCE(acknowledged_by,$2)
       WHERE id=$1 AND jsonb_array_length(COALESCE(sla_breaches,'[]'::jsonb))>0
       RETURNING id AS breach_id,client_id,acknowledged_at,acknowledged_by`, [req.params.id,req.user.id]);
    if (!rows.length) return res.status(404).json({success:false,error:'Breach aggregate not found'});
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to acknowledge breach' }); }
});

module.exports = router;
