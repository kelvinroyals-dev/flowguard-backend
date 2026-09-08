// ============================================================================
// Jobs — Phase 2 backbone
// The dispatchable unit of field work FlowGuard hands to a Service Provider
// Organisation (SPO). Lifecycle:
//   draft → dispatched → accepted → en_route → in_progress → completed → verified
// with off-ramps: declined (SP), rejected (FlowGuard, back to in_progress),
// cancelled (FlowGuard).
//
// Tenancy is enforced HERE, server-side: a service-provider caller only ever
// sees/acts on jobs where jobs.service_provider_org_id === their org (req.user.spo).
// FlowGuard staff (internal) see and drive everything.
// ============================================================================
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { notify, notifyInternal } = require('../utils/notify');

const UPLOAD_BASE = process.env.PUBLIC_UPLOAD_BASE || 'https://api.flowguard.ng/uploads';
const UPLOAD_DIR  = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const EXT = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf' };

// Persist a base64 data-URL to disk and return its public URL (or null).
function saveDataUrl(jobId, dataUrl) {
  try {
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
    if (!m) return null;
    const ext = EXT[m[1].toLowerCase()]; if (!ext) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) return null; // hard cap 12MB
    const dir = path.join(UPLOAD_DIR, 'jobs', String(jobId));
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buf);
    return `${UPLOAD_BASE}/jobs/${jobId}/${name}`;
  } catch (e) { console.error('[saveDataUrl] failed:', e.message); return null; }
}

router.use(authenticateToken);

// ── guards ──────────────────────────────────────────────────────────────────
const requireStaff = [requireRole('admin', 'super_admin', 'operations_manager', 'operations', 'dispatcher'),
  (req, res, next) => (req.user.user_type === 'internal'
    ? next()
    : res.status(403).json({ success: false, error: 'Staff only' }))];

function requireServiceProvider(req, res, next) {
  if (!req.user || req.user.user_type !== 'service_provider' || !req.user.spo) {
    return res.status(403).json({ success: false, error: 'Service provider account required' });
  }
  next();
}
const isStaff = req => req.user && req.user.user_type === 'internal';

const JOB_TYPES = ['inspection', 'drain_cleaning', 'sensor_maintenance', 'repair', 'survey', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// ── helpers ───────────────────────────────────────────────────────────────
async function nextReference() {
  const y = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM jobs WHERE reference LIKE $1`, [`JOB-${y}-%`]);
  return `JOB-${y}-` + String((rows[0].n || 0) + 1).padStart(6, '0');
}

async function logEvent(jobId, req, { event_type, from_status = null, to_status = null, note = null, meta = null }) {
  try {
    await pool.query(
      `INSERT INTO job_events (job_id, event_type, from_status, to_status, actor_id, actor_type, note, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [jobId, event_type, from_status, to_status, req.user.id, req.user.user_type, note, meta ? JSON.stringify(meta) : null]);
  } catch (e) { console.error('[job event] failed:', e.message); }
}

async function notifySpoMembers(orgId, opts) {
  if (!orgId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE service_provider_org_id = $1 AND is_active = true`, [orgId]);
    await Promise.all(rows.map(r => notify(r.id, opts)));
  } catch (e) { console.error('[notifySpo] failed:', e.message); }
}

// Dispatching a job for a property implies that provider may operate on it.
// Upsert the tenancy assignment so the SP's Properties view stays in sync and
// property-scoped reads have a row to key off. Best-effort — never block dispatch.
async function ensureAssignment(orgId, propertyId, staffId) {
  if (!orgId || !propertyId) return;
  try {
    await pool.query(
      `INSERT INTO service_provider_property_assignments (service_provider_org_id, property_id, assigned_by, active)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (service_provider_org_id, property_id)
       DO UPDATE SET active = TRUE, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()`,
      [orgId, propertyId, staffId || null]);
  } catch (e) { console.error('[ensureAssignment] failed:', e.message); }
}

// Load a job and enforce tenancy. Returns the row or sends a 403/404 and returns null.
async function loadJob(req, res, id) {
  const jid = parseInt(id, 10);
  if (!Number.isInteger(jid)) { res.status(400).json({ success: false, error: 'Invalid id' }); return null; }
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jid]);
  const job = rows[0];
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return null; }
  if (!isStaff(req) && job.service_provider_org_id !== req.user.spo) {
    // Don't leak existence to a provider that doesn't own it.
    res.status(404).json({ success: false, error: 'Job not found' }); return null;
  }
  return job;
}

// Validate that a completion has all required evidence.
function missingRequiredEvidence(job, evidenceRows) {
  const req = Array.isArray(job.required_evidence) ? job.required_evidence : [];
  const haveKeys = new Set((evidenceRows || []).map(e => e.evidence_key).filter(Boolean));
  return req.filter(r => r && r.required && !haveKeys.has(r.key)).map(r => r.label || r.key);
}

// ─────────────────────────────────────────────────────────────────────────
//  LIST + READ (both audiences, scoped)
// ─────────────────────────────────────────────────────────────────────────

// GET /jobs?status=&org=&property=&job_type=
router.get('/', async (req, res) => {
  try {
    const where = []; const params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', '$' + params.length)); };

    if (!isStaff(req)) {
      if (!req.user.spo) return res.status(403).json({ success: false, error: 'Service provider account required' });
      add('j.service_provider_org_id = $?', req.user.spo);
    } else if (req.query.org) {
      add('j.service_provider_org_id = $?', parseInt(req.query.org, 10));
    }
    if (req.query.status)   add('j.status = $?', req.query.status);
    if (req.query.property) add('j.property_id = $?', parseInt(req.query.property, 10));
    if (req.query.job_type) add('j.job_type = $?', req.query.job_type);

    const sql = `
      SELECT j.*, p.property_name AS property_name,
             CONCAT_WS(', ', p.city, p.state) AS property_address,
             o.name AS provider_name,
             u.full_name AS technician_name,
             (SELECT COUNT(*)::int FROM job_evidence e WHERE e.job_id = j.id) AS evidence_count
        FROM jobs j
        LEFT JOIN properties p ON p.property_id = j.property_id
        LEFT JOIN service_provider_organisations o ON o.id = j.service_provider_org_id
        LEFT JOIN users u ON u.id = j.assigned_technician_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY j.created_at DESC
        LIMIT 300`;
    const { rows } = await pool.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /jobs', err); return res.status(500).json({ success: false, error: 'Failed to list jobs' }); }
});

// GET /jobs/evidence-templates  (staff) — must precede /:id
router.get('/evidence-templates', requireStaff, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM job_evidence_templates ORDER BY job_type');
    return res.json({ success: true, data: rows });
  } catch (err) { console.error('GET evidence-templates', err); return res.status(500).json({ success: false, error: 'Failed to load templates' }); }
});

// PUT /jobs/evidence-templates/:jobType  (staff)  body: { required:[{key,label,kind,required}] }
router.put('/evidence-templates/:jobType', requireStaff, async (req, res) => {
  try {
    const jobType = req.params.jobType;
    if (!JOB_TYPES.includes(jobType)) return res.status(400).json({ success: false, error: 'Unknown job type' });
    const required = Array.isArray(req.body && req.body.required) ? req.body.required : [];
    const { rows } = await pool.query(
      `INSERT INTO job_evidence_templates (job_type, required, updated_by, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (job_type) DO UPDATE SET required = EXCLUDED.required, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`, [jobType, JSON.stringify(required), req.user.id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT evidence-templates', err); return res.status(500).json({ success: false, error: 'Failed to save template' }); }
});

// GET /jobs/:id  → job + events + evidence
router.get('/:id', async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  try {
    const events = (await pool.query('SELECT * FROM job_events WHERE job_id = $1 ORDER BY created_at', [job.id])).rows;
    const evidence = (await pool.query('SELECT * FROM job_evidence WHERE job_id = $1 ORDER BY created_at', [job.id])).rows;
    const prop = job.property_id
      ? (await pool.query('SELECT property_id, property_name, city, state, country, latitude, longitude FROM properties WHERE property_id = $1', [job.property_id])).rows[0]
      : null;
    return res.json({ success: true, data: { ...job, property: prop, events, evidence } });
  } catch (err) { console.error('GET /jobs/:id', err); return res.status(500).json({ success: false, error: 'Failed to load job' }); }
});

// ─────────────────────────────────────────────────────────────────────────
//  FLOWGUARD STAFF — create, dispatch, verify, reject, cancel
// ─────────────────────────────────────────────────────────────────────────

// POST /jobs  → create a draft (or dispatch straight away if org supplied)
router.post('/', requireStaff, async (req, res) => {
  try {
    const b = req.body || {};
    const jobType = b.job_type;
    if (!JOB_TYPES.includes(jobType)) return res.status(400).json({ success: false, error: 'Valid job_type required' });
    if (!b.title) return res.status(400).json({ success: false, error: 'Title required' });
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';

    // Required-evidence snapshot: explicit override, else the job_type template.
    let required = Array.isArray(b.required_evidence) ? b.required_evidence : null;
    if (!required) {
      const t = (await pool.query('SELECT required FROM job_evidence_templates WHERE job_type = $1', [jobType])).rows[0];
      required = (t && t.required) || [];
    }

    const ref = await nextReference();
    const orgId = b.service_provider_org_id ? parseInt(b.service_provider_org_id, 10) : null;
    const status = orgId ? 'dispatched' : 'draft';

    const { rows } = await pool.query(
      `INSERT INTO jobs
        (reference, property_id, service_provider_org_id, job_type, title, description, priority,
         status, source_ticket_id, required_evidence, scheduled_for, sla_due_at, created_by, dispatched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [ref, b.property_id || null, orgId, jobType, b.title, b.description || null, priority,
       status, b.source_ticket_id || null, JSON.stringify(required),
       b.scheduled_for || null, b.sla_due_at || null, req.user.id, orgId ? new Date() : null]);
    const job = rows[0];

    await logEvent(job.id, req, { event_type: 'created', to_status: status, note: b.title });
    if (orgId) {
      await ensureAssignment(orgId, job.property_id, req.user.id);
      await logEvent(job.id, req, { event_type: 'dispatched', from_status: 'draft', to_status: 'dispatched' });
      notifySpoMembers(orgId, { type: 'info', title: 'New job dispatched to you',
        message: `${job.reference} — ${job.title}`, link: '#jobs/' + job.id });
    }
    return res.status(201).json({ success: true, data: job });
  } catch (err) { console.error('POST /jobs', err); return res.status(500).json({ success: false, error: 'Failed to create job' }); }
});

// POST /jobs/:id/dispatch  body:{ service_provider_org_id, sla_due_at?, scheduled_for? }
router.post('/:id/dispatch', requireStaff, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (!['draft', 'declined'].includes(job.status))
    return res.status(409).json({ success: false, error: `Cannot dispatch a job that is ${job.status}` });
  const orgId = parseInt((req.body || {}).service_provider_org_id, 10);
  if (!Number.isInteger(orgId)) return res.status(400).json({ success: false, error: 'service_provider_org_id required' });
  try {
    const org = (await pool.query(`SELECT id, status, name FROM service_provider_organisations WHERE id = $1`, [orgId])).rows[0];
    if (!org) return res.status(404).json({ success: false, error: 'Provider not found' });
    if (org.status !== 'active') return res.status(409).json({ success: false, error: 'Provider is not active' });

    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE jobs SET service_provider_org_id = $2, status = 'dispatched', dispatched_at = NOW(),
              assigned_technician_id = NULL, decline_reason = NULL,
              sla_due_at = COALESCE($3, sla_due_at), scheduled_for = COALESCE($4, scheduled_for), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [job.id, orgId, b.sla_due_at || null, b.scheduled_for || null]);
    await ensureAssignment(orgId, job.property_id, req.user.id);
    await logEvent(job.id, req, { event_type: 'dispatched', from_status: job.status, to_status: 'dispatched', meta: { org: orgId } });
    notifySpoMembers(orgId, { type: 'info', title: 'New job dispatched to you',
      message: `${job.reference} — ${job.title}`, link: '#jobs/' + job.id });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST dispatch', err); return res.status(500).json({ success: false, error: 'Failed to dispatch' }); }
});

// POST /jobs/:id/verify  (completed → verified)
router.post('/:id/verify', requireStaff, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (job.status !== 'completed')
    return res.status(409).json({ success: false, error: 'Only a completed job can be verified' });
  try {
    const note = (req.body || {}).note || null;
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'verified', verified_at = NOW(), verified_by = $2, verify_note = $3, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [job.id, req.user.id, note]);
    await logEvent(job.id, req, { event_type: 'verified', from_status: 'completed', to_status: 'verified', note });
    notifySpoMembers(job.service_provider_org_id, { type: 'success', title: 'Job verified',
      message: `${job.reference} — ${job.title} was verified`, link: '#jobs/' + job.id });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST verify', err); return res.status(500).json({ success: false, error: 'Failed to verify' }); }
});

// POST /jobs/:id/reject  (completed → in_progress)  body:{ reason }
router.post('/:id/reject', requireStaff, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (job.status !== 'completed')
    return res.status(409).json({ success: false, error: 'Only a completed job can be rejected' });
  const reason = (req.body || {}).reason;
  if (!reason) return res.status(400).json({ success: false, error: 'A reason is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'in_progress', reject_reason = $2, completed_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [job.id, reason]);
    await logEvent(job.id, req, { event_type: 'rejected', from_status: 'completed', to_status: 'in_progress', note: reason });
    notifySpoMembers(job.service_provider_org_id, { type: 'warning', title: 'Job returned for rework',
      message: `${job.reference} — ${reason}`, link: '#jobs/' + job.id });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST reject', err); return res.status(500).json({ success: false, error: 'Failed to reject' }); }
});

// POST /jobs/:id/cancel  body:{ reason? }
router.post('/:id/cancel', requireStaff, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (['verified', 'cancelled'].includes(job.status))
    return res.status(409).json({ success: false, error: `Cannot cancel a job that is ${job.status}` });
  try {
    const reason = (req.body || {}).reason || null;
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'cancelled', cancel_reason = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [job.id, reason]);
    await logEvent(job.id, req, { event_type: 'cancelled', from_status: job.status, to_status: 'cancelled', note: reason });
    if (job.service_provider_org_id) notifySpoMembers(job.service_provider_org_id, { type: 'warning',
      title: 'Job cancelled', message: `${job.reference} — ${job.title}`, link: '#jobs/' + job.id });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST cancel', err); return res.status(500).json({ success: false, error: 'Failed to cancel' }); }
});

// ─────────────────────────────────────────────────────────────────────────
//  SERVICE PROVIDER — accept/decline/en_route/start/complete + evidence
// ─────────────────────────────────────────────────────────────────────────

// POST /jobs/:id/accept  body:{ technician_id? }  (dispatched → accepted)
router.post('/:id/accept', requireServiceProvider, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (job.status !== 'dispatched')
    return res.status(409).json({ success: false, error: `Cannot accept a job that is ${job.status}` });
  try {
    // A supervisor/owner_admin may assign a technician; a field technician self-assigns.
    let techId = req.user.id;
    if (req.body && req.body.technician_id && ['owner_admin', 'supervisor'].includes(req.user.sp_role)) {
      const t = (await pool.query(
        'SELECT id FROM users WHERE id = $1 AND service_provider_org_id = $2', [parseInt(req.body.technician_id, 10), req.user.spo])).rows[0];
      if (!t) return res.status(400).json({ success: false, error: 'Technician not in your organisation' });
      techId = t.id;
    }
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'accepted', accepted_at = NOW(), assigned_technician_id = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [job.id, techId]);
    await logEvent(job.id, req, { event_type: 'accepted', from_status: 'dispatched', to_status: 'accepted', meta: { technician: techId } });
    notifyInternal({ type: 'info', title: 'Job accepted', message: `${job.reference} — ${job.title}`, link: '#jobs/' + job.id },
      { roles: notifyInternal.ADMIN });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST accept', err); return res.status(500).json({ success: false, error: 'Failed to accept' }); }
});

// POST /jobs/:id/decline  body:{ reason }  (dispatched → declined)
router.post('/:id/decline', requireServiceProvider, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (job.status !== 'dispatched')
    return res.status(409).json({ success: false, error: `Cannot decline a job that is ${job.status}` });
  const reason = (req.body || {}).reason;
  if (!reason) return res.status(400).json({ success: false, error: 'A reason is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'declined', declined_at = NOW(), decline_reason = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [job.id, reason]);
    await logEvent(job.id, req, { event_type: 'declined', from_status: 'dispatched', to_status: 'declined', note: reason });
    notifyInternal({ type: 'warning', title: 'Job declined by provider',
      message: `${job.reference} — ${reason}`, link: '#jobs/' + job.id }, { roles: notifyInternal.ADMIN });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST decline', err); return res.status(500).json({ success: false, error: 'Failed to decline' }); }
});

// Small state-only transitions: en_route, start
function spTransition(action, from, to, eventType) {
  return async (req, res) => {
    const job = await loadJob(req, res, req.params.id);
    if (!job) return;
    if (!from.includes(job.status))
      return res.status(409).json({ success: false, error: `Cannot ${action} a job that is ${job.status}` });
    try {
      const col = to === 'in_progress' ? ', started_at = NOW()' : '';
      const { rows } = await pool.query(
        `UPDATE jobs SET status = $2 ${col}, updated_at = NOW() WHERE id = $1 RETURNING *`, [job.id, to]);
      await logEvent(job.id, req, { event_type: eventType, from_status: job.status, to_status: to });
      return res.json({ success: true, data: rows[0] });
    } catch (err) { console.error('POST ' + action, err); return res.status(500).json({ success: false, error: `Failed to ${action}` }); }
  };
}
router.post('/:id/en-route', requireServiceProvider, spTransition('set en route', ['accepted'], 'en_route', 'en_route'));
router.post('/:id/start',    requireServiceProvider, spTransition('start', ['accepted', 'en_route'], 'in_progress', 'started'));

// POST /jobs/:id/evidence  body:{ kind, evidence_key?, file_url?, caption?, lat?, lng?, captured_at? }
router.post('/:id/evidence', requireServiceProvider, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (!['accepted', 'en_route', 'in_progress'].includes(job.status))
    return res.status(409).json({ success: false, error: `Cannot add evidence to a job that is ${job.status}` });
  const b = req.body || {};
  const KINDS = ['photo', 'video', 'document', 'note', 'signature', 'gps'];
  if (!KINDS.includes(b.kind)) return res.status(400).json({ success: false, error: 'Valid evidence kind required' });
  try {
    // A base64 file (downscaled on the client) takes priority; otherwise fall
    // back to a pasted URL. Either yields a file_url stored on the row.
    let fileUrl = b.file_url || null;
    if (b.file_data) {
      const saved = saveDataUrl(job.id, b.file_data);
      if (!saved) return res.status(400).json({ success: false, error: 'Unsupported or oversized file (JP, PNG, WEBP or PDF up to 12MB)' });
      fileUrl = saved;
    }
    const { rows } = await pool.query(
      `INSERT INTO job_evidence (job_id, evidence_key, kind, file_url, caption, lat, lng, captured_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [job.id, b.evidence_key || null, b.kind, fileUrl, b.caption || null,
       b.lat != null ? b.lat : null, b.lng != null ? b.lng : null, b.captured_at || null, req.user.id]);
    await logEvent(job.id, req, { event_type: 'evidence_added', meta: { kind: b.kind, key: b.evidence_key || null } });
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST evidence', err); return res.status(500).json({ success: false, error: 'Failed to add evidence' }); }
});

// POST /jobs/:id/complete  (in_progress → completed) — requires all required evidence
router.post('/:id/complete', requireServiceProvider, async (req, res) => {
  const job = await loadJob(req, res, req.params.id);
  if (!job) return;
  if (job.status !== 'in_progress')
    return res.status(409).json({ success: false, error: `Cannot complete a job that is ${job.status}` });
  try {
    const evidence = (await pool.query('SELECT evidence_key FROM job_evidence WHERE job_id = $1', [job.id])).rows;
    const missing = missingRequiredEvidence(job, evidence);
    if (missing.length)
      return res.status(422).json({ success: false, error: 'Missing required evidence', missing });
    const note = (req.body || {}).note || null;
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [job.id]);
    await logEvent(job.id, req, { event_type: 'completed', from_status: 'in_progress', to_status: 'completed', note });
    notifyInternal({ type: 'success', title: 'Job completed — awaiting verification',
      message: `${job.reference} — ${job.title}`, link: '#jobs/' + job.id }, { roles: notifyInternal.ADMIN });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST complete', err); return res.status(500).json({ success: false, error: 'Failed to complete' }); }
});

module.exports = router;
