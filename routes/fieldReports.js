// Field reports — backed by inspection_reports
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
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
      // Clients see reports for their own properties AND only once ops has sent
      // them — drafts/unapproved reports must not leak before the send action.
      clientFilter = ` AND ir.property_id = ANY($2) AND ir.sent_to_client_at IS NOT NULL`;
      params = [limit, pids];
    }
    // ?mine=1 — a field agent reviewing their own submitted reports (job history).
    let mineFilter = '';
    if (!isClient(req) && (req.query.mine === '1' || req.query.mine === 'true')) {
      params.push(String(req.user.id));
      mineFilter = ` AND ir.submitted_by = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT ir.report_id, ir.inspection_id, ir.property_id, ir.status,
             ir.title, COALESCE(ir.summary, ir.executive_summary) AS summary, ir.executive_summary,
             ir.report_type, ir.alert_id, ir.materials_used, ir.work_duration_min,
             ir.submitted_by, ir.created_at, ir.updated_at, ir.approved_by, ir.sent_to_client_at,
             COALESCE(ir.submitted_by_name, i.assigned_agent_name) AS submitted_by_name,
             p.property_name, p.city, p.state,
             i.assigned_team AS team_name,
             COALESCE(ir.findings, i.findings) AS findings,
             COALESCE(ir.recommendations, i.recommendations) AS recommendations,
             i.flood_risk_level, i.drainage_condition_score
      FROM inspection_reports ir
      LEFT JOIN properties p ON ir.property_id = p.property_id
      LEFT JOIN inspections i ON ir.inspection_id = i.inspection_id
      WHERE 1=1${clientFilter}${mineFilter}
      ORDER BY ir.created_at DESC LIMIT $1`, params);
    const data = rows.map(r => ({ ...r, status: toFe(r.status) }));
    res.json({ success: true, data });
  } catch (err) { console.error('GET /field-reports', err); res.status(500).json({ success:false, error:'Failed to load field reports' }); }
});

// POST /field-reports — a field agent (or ops) files a report from the field
// portal. Stores the full report the agent typed (previously there was no create
// route at all → "Not found: POST /api/v1/field-reports").
router.post('/', authenticateToken, requirePermission('field-reports.manage'), async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const b = req.body || {};
    const reportId = 'FR-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);
    // Field portal sends 'submitted' or 'draft'; DB allows draft/review/approved/
    // sent_to_client. A submitted field report enters ops review.
    const dbStatus = (b.status === 'draft') ? 'draft' : 'review';
    let name = req.user.email;
    try { const u = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]); if (u.rows[0] && u.rows[0].full_name) name = u.rows[0].full_name; } catch (_) {}
    const { rows } = await pool.query(
      `INSERT INTO inspection_reports
         (report_id, inspection_id, property_id, report_type, alert_id,
          title, summary, executive_summary, findings, recommendations,
          materials_used, work_duration_min, status, submitted_by, submitted_by_name,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
       RETURNING *`,
      [reportId, b.inspection_id || null, b.property_id || null, b.report_type || null, b.alert_id || null,
       b.title || null, b.summary || null, b.summary || b.title || null, b.findings || null, b.recommendations || null,
       b.materials_used || null, (parseInt(b.work_duration_min) || null), dbStatus, String(req.user.id), name]);
    logAction(req.user.id, 'submitted a field report', 'report', reportId, { status: dbStatus });
    // mirror findings/recs onto the linked inspection so the ops property view
    // (which reads i.findings/i.recommendations) stays in step.
    if (b.inspection_id && (b.findings || b.recommendations)) {
      pool.query(`UPDATE inspections SET findings=COALESCE($1,findings), recommendations=COALESCE($2,recommendations), updated_at=NOW() WHERE inspection_id=$3`,
        [b.findings || null, b.recommendations || null, b.inspection_id]).catch(() => {});
    }
    const out = rows[0]; out.status = toFe(out.status);
    res.status(201).json({ success: true, data: out });
  } catch (err) { console.error('POST /field-reports', err); res.status(500).json({ success: false, error: 'Failed to submit report' }); }
});

// GET /field-reports/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { isClient, propertyIdsForUser } = require('../utils/scope');
    const { rows } = await pool.query(`
      SELECT ir.*, p.property_name, p.city, p.state,
             i.assigned_agent_name AS submitted_by_name, i.assigned_team AS team_name,
             i.findings, i.recommendations, i.flood_risk_level, i.drainage_condition_score
      FROM inspection_reports ir
      LEFT JOIN properties p ON ir.property_id=p.property_id
      LEFT JOIN inspections i ON ir.inspection_id=i.inspection_id
      WHERE ir.report_id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    if (isClient(req)) {
      const pids = await propertyIdsForUser(req.user.id);
      if (!pids.includes(rows[0].property_id) || !rows[0].sent_to_client_at) {
        return res.status(403).json({ success: false, error: 'Not authorised' });
      }
    }
    rows[0].status = toFe(rows[0].status);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load report' }); }
});

// PUT /field-reports/:id  (edit + status change) — ops only: this is the
// inspection report an ops/field user drafts and approves, not something a
// client edits.
router.put('/:id', authenticateToken, requirePermission('field-reports.manage'), async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const sets = [], vals = []; let i = 1;
    const FIELDS = ['title', 'summary', 'findings', 'recommendations', 'materials_used', 'work_duration_min', 'executive_summary'];
    for (const f of FIELDS) {
      if (f in req.body) { sets.push(`${f}=$${i++}`); vals.push(f === 'work_duration_min' ? (parseInt(req.body[f]) || null) : req.body[f]); }
    }
    if ('status' in req.body) { sets.push(`status=$${i++}`); vals.push(toDb(req.body.status)); }
    if (!sets.length) return res.status(400).json({ success:false, error:'No valid fields' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE inspection_reports SET ${sets.join(', ')}, updated_at=NOW() WHERE report_id=$${i} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    // keep the linked inspection in step with edited findings/recommendations
    if (rows[0].inspection_id && ('findings' in req.body || 'recommendations' in req.body)) {
      pool.query(`UPDATE inspections SET findings=COALESCE($1,findings), recommendations=COALESCE($2,recommendations), updated_at=NOW() WHERE inspection_id=$3`,
        [req.body.findings ?? null, req.body.recommendations ?? null, rows[0].inspection_id]).catch(() => {});
    }
    rows[0].status = toFe(rows[0].status);
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT /field-reports/:id', err); res.status(500).json({ success:false, error:'Failed to update report' }); }
});

// POST /field-reports/:id/send-to-client — ops only.
router.post('/:id/send-to-client', authenticateToken, requirePermission('field-reports.manage'), async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(
      `UPDATE inspection_reports SET status='sent_to_client', sent_to_client_at=NOW(), updated_at=NOW()
       WHERE report_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Report not found' });
    realtime.events.reportSent(rows[0]);
    logAction(req.user.id, 'sent inspection report', 'report', rows[0].report_id, { property_id: rows[0].property_id });
    pool.query(`INSERT INTO property_events (property_id, event_type, description, created_by) VALUES ($1,'report_delivered','Inspection report delivered',$2)`, [rows[0].property_id, req.user.id]).catch(()=>{});
    // In-app notification for the property owner.
    pool.query('SELECT user_id FROM properties WHERE property_id=$1', [rows[0].property_id])
      .then(pr => pr.rows[0] && require('../utils/notify').notify(pr.rows[0].user_id, {
        type: 'report', title: 'Your inspection report is ready', message: 'Tap to review your assessment report.', link: '#reports',
      })).catch(() => {});
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
