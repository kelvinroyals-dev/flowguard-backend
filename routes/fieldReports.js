// Field reports — backed by inspection_reports
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const realtime = require('../realtime/io');
const router = express.Router();
const { logAction } = require('../utils/audit');

// map db status -> frontend status
const toFe = s => (s === 'review' ? 'under_review' : s);
const toDb = s => (s === 'under_review' ? 'review' : s);

// GET /field-reports?status=&limit=
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    // Client-role users only see reports for their own properties; ops see all.
    const { isClient, propertyIdsForUser } = require('../utils/scope');
    let clientFilter = '';
    let params = [limit];
    if (isClient(req)) {
      const pids = await propertyIdsForUser(req.user.id);
      if (!pids.length) return res.json({ success: true, data: [] });
      clientFilter = ` AND ir.property_id = ANY($2)`;
      params = [limit, pids];
    }
    const { rows } = await pool.query(`
      SELECT ir.report_id, ir.inspection_id, ir.property_id, ir.status,
             ir.executive_summary, ir.created_at, ir.updated_at,
             ir.approved_by, ir.sent_to_client_at,
             p.property_name, p.city, p.state,
             i.assigned_agent_name AS submitted_by_name, i.assigned_team AS team_name,
             i.findings, i.recommendations, i.flood_risk_level, i.drainage_condition_score
      FROM inspection_reports ir
      LEFT JOIN properties p ON ir.property_id = p.property_id
      LEFT JOIN inspections i ON ir.inspection_id = i.inspection_id
      WHERE 1=1${clientFilter}
      ORDER BY ir.created_at DESC LIMIT $1`, params);
    const data = rows.map(r => ({ ...r, status: toFe(r.status) }));
    res.json({ success: true, data });
  } catch (err) { console.error('GET /field-reports', err); res.status(500).json({ success:false, error:'Failed to load field reports' }); }
});

// GET /field-reports/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ir.*, p.property_name, p.city, p.state,
             i.assigned_agent_name AS submitted_by_name, i.assigned_team AS team_name,
             i.findings, i.recommendations, i.flood_risk_level, i.drainage_condition_score
      FROM inspection_reports ir
      LEFT JOIN properties p ON ir.property_id=p.property_id
      LEFT JOIN inspections i ON ir.inspection_id=i.inspection_id
      WHERE ir.report_id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    rows[0].status = toFe(rows[0].status);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load report' }); }
});

// PUT /field-reports/:id  (edit + status change)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const sets = [], vals = []; let i = 1;
    if ('executive_summary' in req.body) { sets.push(`executive_summary=$${i++}`); vals.push(req.body.executive_summary); }
    if ('status' in req.body) { sets.push(`status=$${i++}`); vals.push(toDb(req.body.status)); }
    if (!sets.length) return res.status(400).json({ success:false, error:'No valid fields' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE inspection_reports SET ${sets.join(', ')}, updated_at=NOW() WHERE report_id=$${i} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    rows[0].status = toFe(rows[0].status);
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT /field-reports/:id', err); res.status(500).json({ success:false, error:'Failed to update report' }); }
});

// POST /field-reports/:id/send-to-client
router.post('/:id/send-to-client', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE inspection_reports SET status='sent_to_client', sent_to_client_at=NOW(), updated_at=NOW()
       WHERE report_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    realtime.events.reportSent(rows[0]);
    logAction(req.user.id, 'sent inspection report', 'report', rows[0].report_id, { property_id: rows[0].property_id });
    pool.query(`INSERT INTO property_events (property_id, event_type, description, created_by) VALUES ($1,'report_delivered','Inspection report delivered',$2)`, [rows[0].property_id, req.user.id]).catch(()=>{});
    res.json({ success: true, data: { sent: true } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to send report' }); }
});

// GET /field-reports/:id/pdf — generate & stream a branded PDF report.
// Clients can only download reports for their own properties; ops can download any.
router.get('/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { isClient, propertyIdsForUser } = require('../utils/scope');
    const { rows } = await pool.query(`
      SELECT ir.*, 
             p.property_name, p.city, p.state,
             i.assigned_agent_name AS submitted_by_name, i.assigned_team AS team_name,
             i.findings, i.recommendations, i.flood_risk_level, i.drainage_condition_score
      FROM inspection_reports ir
      LEFT JOIN properties p ON ir.property_id = p.property_id
      LEFT JOIN inspections i ON ir.inspection_id = i.inspection_id
      WHERE ir.report_id = $1`, [req.params.id]);
    const report = rows[0];
    if (!report) return res.status(404).json({ success: false, error: 'Report not found' });

    // scope: client can only fetch reports for their own properties
    if (isClient(req)) {
      const pids = await propertyIdsForUser(req.user.id);
      if (!pids.includes(report.property_id)) {
        return res.status(403).json({ success: false, error: 'Not authorised to access this report' });
      }
    }

    const { generateReportPdf } = require('../utils/reportPdf');
    const pdf = await generateReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FlowGuard-Report-${report.report_id}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    console.error('GET /field-reports/:id/pdf', err);
    res.status(500).json({ success: false, error: 'Failed to generate report PDF' });
  }
});

module.exports = router;
