// Reports — generated analytics reports
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { isClient, isSpUser } = require('../utils/scope');
const { randomUUID } = require('node:crypto');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Attachment navigation cannot send a bearer header. A five-minute, single-report
// capability is separate from login JWTs and rechecks the live account and grants.
router.get('/snapshot', async (req,res) => {
  let capability;
  try {capability=jwt.verify(req.query.t,process.env.JWT_SECRET);} catch (_) {return res.status(401).json({success:false,error:'Expired or invalid snapshot link'});}
  if (capability.purpose!=='report-snapshot' || !capability.report_id || !capability.uid) return res.status(401).json({success:false,error:'Invalid snapshot link'});
  try {
    const user=(await pool.query('SELECT id,role,user_type,is_active,token_version FROM users WHERE id=$1',[capability.uid])).rows[0];
    if (!user || !user.is_active || user.user_type!=='internal' || Number(user.token_version || 0)!==Number(capability.tv) || !(await hasPermission(user.role,'reports.view'))) return res.status(403).json({success:false,error:'Snapshot access revoked'});
    const record=(await pool.query('SELECT report_id,metrics FROM reports WHERE report_id=$1',[capability.report_id])).rows[0];
    if (!record || record.metrics?.schema_version!==1) return res.status(404).json({success:false,error:'Snapshot unavailable'});
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Type','application/json');
    res.setHeader('Content-Disposition',`attachment; filename="${String(record.report_id).replace(/[^A-Za-z0-9_-]/g,'')}.json"`);
    res.send(JSON.stringify(record.metrics,null,2));
  } catch(error) {res.status(500).json({success:false,error:'Failed to download snapshot'});}
});

// Company-wide analytics reports (across all clients) — ops only.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req) || isSpUser(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});
router.use(requirePermission('reports.view'));

// GET /reports
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.report_id, r.report_id AS id, r.report_type AS type,
             CASE r.report_type WHEN 'daily' THEN 'Daily operations' WHEN 'weekly' THEN 'Weekly operations'
               WHEN 'monthly' THEN 'Monthly operations' WHEN 'financial' THEN 'Invoice balance snapshot'
               ELSE r.report_type END AS name,
             CASE WHEN r.metrics->>'schema_version'='1' THEN 'JSON snapshot' END AS format,
             r.period_start, r.period_end, r.metrics, r.file_url, r.generated_at,
             u.full_name AS generated_by_name, c.name AS client_name
      FROM reports r LEFT JOIN users u ON r.generated_by=u.id
      LEFT JOIN clients c ON r.client_id=c.id
      ORDER BY r.generated_at DESC`);
    for (const row of rows) if (row.metrics?.schema_version===1) {
      const token=jwt.sign({purpose:'report-snapshot',report_id:row.report_id,uid:req.user.id,tv:req.user.tv ?? req.user.token_version ?? 0},process.env.JWT_SECRET,{expiresIn:'5m'});
      row.snapshot_download_path='/reports/snapshot?t='+encodeURIComponent(token);
    }
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /reports', err); res.status(500).json({ success:false, error:'Failed to load reports' }); }
});

// POST /reports/generate  body: { type }
router.post('/generate', authenticateToken, requirePermission('reports.manage'), async (req, res) => {
  try {
    const { type } = req.body || {};
    if (!['daily','weekly','monthly','financial'].includes(type)) return res.status(400).json({success:false,error:'Unsupported report type'});
    const period=(await pool.query(`SELECT
      CASE WHEN $1='daily' THEN CURRENT_DATE
           WHEN $1='weekly' THEN CURRENT_DATE-6
           ELSE date_trunc('month',CURRENT_DATE)::date END::text AS start,
      CURRENT_DATE::text AS end,
      (CURRENT_DATE+1)::text AS end_exclusive`,[type])).rows[0];
    // A stored, reproducible snapshot of records raised in this UTC SQL period.
    // No invented forecast, contractual assessment, financial collection or PDF.
    let metrics;
    if (type === 'financial') {
      const {rows:[invoice]}=await pool.query(`SELECT COUNT(*)::integer invoice_count,
        SUM(total_amount) total_invoiced, SUM(balance_due) outstanding_balance,
        COUNT(*) FILTER(WHERE total_amount IS NOT NULL)::integer amount_record_count,
        COUNT(*) FILTER(WHERE balance_due IS NOT NULL)::integer balance_record_count
        FROM invoices WHERE issue_date >= $1::date AND issue_date < $2::date`,[period.start,period.end_exclusive]);
      const groups=(await pool.query(`SELECT currency,COUNT(*)::integer invoice_count,SUM(total_amount) total_invoiced,SUM(balance_due) outstanding_balance FROM invoices WHERE issue_date >= $1::date AND issue_date < $2::date GROUP BY currency ORDER BY currency`,[period.start,period.end_exclusive])).rows;
      const knownSingle=groups.length===1 && /^[A-Z]{3}$/.test(String(groups[0].currency || ''));
      invoice.currency=knownSingle ? groups[0].currency : null;
      if (!knownSingle) {invoice.total_invoiced=null;invoice.outstanding_balance=null;}
      metrics={invoice_snapshot:invoice,invoice_currency_groups:groups,
        limitations:['Recorded invoice balances, not a reconciled payment ledger or cash collected.','Currency groups are not converted or combined; contractual revenue recognition is not supplied.']};
    } else {
      const {rows:[incidents]}=await pool.query(`SELECT COUNT(*)::integer raised,
        COUNT(*) FILTER(WHERE severity='critical')::integer critical,
        COUNT(*) FILTER(WHERE status='active')::integer currently_active,
        COUNT(*) FILTER(WHERE resolved_at IS NOT NULL)::integer recorded_resolutions
        FROM alerts WHERE created_at >= $1::date AND created_at < $2::date`,[period.start,period.end_exclusive]);
      const {rows:[maintenance]}=await pool.query(`SELECT COUNT(*)::integer created,
        COUNT(*) FILTER(WHERE completed_at IS NOT NULL)::integer recorded_completions
        FROM tickets WHERE work_type IS NOT NULL AND created_at >= $1::date AND created_at < $2::date`,[period.start,period.end_exclusive]);
      metrics={incidents,maintenance,limitations:[
        'Records created in the coverage period, with their state at generation time; not all activity occurring in the period.',
        'Recorded completion is not verified field evidence or a measured intervention effect.',
        'No contractual compliance, forecast or telemetry-coverage assessment is inferred.'
      ]};
    }
    metrics.schema_version=1;metrics.generated_at=new Date().toISOString();
    metrics.coverage={start:period.start,end_exclusive:period.end_exclusive,time_zone:'UTC'};
    const reportId = 'RPT-' + randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO reports (report_id, report_type, generated_by, period_start, period_end, metrics)
       VALUES ($1,$2,$3,$4::date,$5::date,$6::jsonb) RETURNING *`,
      [reportId,type,req.user.id,period.start,period.end,JSON.stringify(metrics)]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST /reports/generate', err); res.status(500).json({ success:false, error:'Failed to generate report' }); }
});

module.exports = router;
