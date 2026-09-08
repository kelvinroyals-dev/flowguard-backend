// Service Provider Organisations (SPO) — external, multi-tenant.
// SP self-service (their own org) + FlowGuard ops review/approval.
// The ORG is the tenant and the thing that gets approved.
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

router.use(authenticateToken);

// ── guards ─────────────────────────────────────────────────────────────
// A service-provider user acting on their own org.
function requireServiceProvider(req, res, next) {
  if (!req.user || req.user.user_type !== 'service_provider' || !req.user.spo) {
    return res.status(403).json({ success: false, error: 'Service provider account required' });
  }
  next();
}
// Only owner_admin can edit org profile / submit for verification.
function requireOrgAdmin(req, res, next) {
  if (req.user && req.user.sp_role === 'owner_admin') return next();
  return res.status(403).json({ success: false, error: 'Only an organisation administrator can do this' });
}
// FlowGuard staff only (approvals). Never a client or service provider.
const requireStaff = [requireRole('admin', 'super_admin', 'operations_manager', 'operations'),
  (req, res, next) => (req.user.user_type === 'internal'
    ? next()
    : res.status(403).json({ success: false, error: 'Staff only' }))];

const REJECT_REASONS = {
  incomplete_info:     'Incomplete information',
  unsupported_area:    'Unsupported coverage area',
  verification_failed: 'Verification failed',
  other:               'Application not accepted',
};

// ─────────────────────────────────────────────────────────────────────────
//  SERVICE PROVIDER — self-service (their own organisation)
// ─────────────────────────────────────────────────────────────────────────

// GET /service-providers/me  → the caller's org + member count
router.get('/me', requireServiceProvider, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.service_provider_org_id = o.id) AS member_count
         FROM service_provider_organisations o WHERE o.id = $1`, [req.user.spo]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Organisation not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('GET /service-providers/me', err); return res.status(500).json({ success: false, error: 'Failed to load organisation' }); }
});

// PUT /service-providers/me  → update profile (owner_admin), while pending or active
router.put('/me', requireServiceProvider, requireOrgAdmin, async (req, res) => {
  try {
    const { name, contactPerson, phone, coverageArea, serviceTypes } = req.body || {};
    const types = Array.isArray(serviceTypes) ? serviceTypes
      : (serviceTypes ? String(serviceTypes).split(',').map(s => s.trim()).filter(Boolean) : null);
    const { rows } = await pool.query(
      `UPDATE service_provider_organisations
          SET name = COALESCE($2, name), contact_person = COALESCE($3, contact_person),
              phone = COALESCE($4, phone), coverage_area = COALESCE($5, coverage_area),
              service_types = COALESCE($6, service_types), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.user.spo, name || null, contactPerson || null, phone || null, coverageArea || null, types]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT /service-providers/me', err); return res.status(500).json({ success: false, error: 'Failed to update organisation' }); }
});

// POST /service-providers/me/submit-verification  → mark ready for review
router.post('/me/submit-verification', requireServiceProvider, requireOrgAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE service_provider_organisations SET verification_submitted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending' RETURNING *`, [req.user.spo]);
    try {
      const { notifyInternal } = require('../utils/notify');
      notifyInternal({ type: 'service_provider', title: 'Provider submitted for verification',
        message: (rows[0] && rows[0].name || 'A provider') + ' is ready for review',
        link: '#service-providers/' + req.user.spo }, { roles: notifyInternal.ADMIN });
    } catch (_) {}
    return res.json({ success: true, data: rows[0] || null });
  } catch (err) { console.error('POST submit-verification', err); return res.status(500).json({ success: false, error: 'Failed to submit' }); }
});

// GET /service-providers/me/properties  → properties assigned to the caller's org
router.get('/me/properties', requireServiceProvider, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.property_id, p.property_name, p.property_type, p.city, p.state, p.country,
              p.latitude, p.longitude, a.assigned_at
         FROM service_provider_property_assignments a
         JOIN properties p ON p.property_id = a.property_id
        WHERE a.service_provider_org_id = $1 AND a.active = TRUE
        ORDER BY a.assigned_at DESC`, [req.user.spo]);
    return res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /me/properties', err); return res.status(500).json({ success: false, error: 'Failed to load properties' }); }
});

// ─────────────────────────────────────────────────────────────────────────
//  FLOWGUARD OPS — review & approval (staff only)
// ─────────────────────────────────────────────────────────────────────────

// GET /service-providers?status=pending  → list orgs for review
router.get('/', requireStaff, async (req, res) => {
  try {
    const status = req.query.status;
    const params = []; let where = '';
    if (status) { params.push(status); where = 'WHERE o.status = $1'; }
    const { rows } = await pool.query(
      `SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.service_provider_org_id = o.id) AS member_count
         FROM service_provider_organisations o ${where} ORDER BY o.created_at DESC`, params);
    return res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /service-providers', err); return res.status(500).json({ success: false, error: 'Failed to list providers' }); }
});

// GET /service-providers/:id  → org detail + members
router.get('/:id', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const org = (await pool.query('SELECT * FROM service_provider_organisations WHERE id = $1', [id])).rows[0];
    if (!org) return res.status(404).json({ success: false, error: 'Not found' });
    const members = (await pool.query(
      'SELECT id, full_name, email, phone, sp_role, is_active FROM users WHERE service_provider_org_id = $1 ORDER BY id', [id])).rows;
    return res.json({ success: true, data: { ...org, members } });
  } catch (err) { console.error('GET /service-providers/:id', err); return res.status(500).json({ success: false, error: 'Failed to load provider' }); }
});

// POST /service-providers/:id/approve
router.post('/:id/approve', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `UPDATE service_provider_organisations
          SET status = 'active', approved_at = NOW(), approved_by = $2, reject_reason = NULL, reject_note = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
    (async () => {
      try {
        const mailer = require('../utils/mailer');
        if (rows[0].email) await mailer.sendEmail({ to: rows[0].email,
          subject: 'Your FlowGuard provider account is approved',
          html: `<p>Good news — <b>${rows[0].name}</b> has been approved as a FlowGuard Service Provider.</p>`
              + `<p>You can now <a href="https://app.flowguard.ng/field">sign in to your provider portal</a> and start receiving jobs.</p>` });
      } catch (e) { console.error('[sp approve] mail', e.message); }
    })();
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST approve', err); return res.status(500).json({ success: false, error: 'Failed to approve' }); }
});

// POST /service-providers/:id/reject   body: { reason, note? }
router.post('/:id/reject', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const reason = (req.body && req.body.reason) || 'other';
    const note = (req.body && req.body.note) || null;
    if (!REJECT_REASONS[reason]) return res.status(400).json({ success: false, error: 'Invalid reason' });
    const { rows } = await pool.query(
      `UPDATE service_provider_organisations
          SET status = 'rejected', reject_reason = $2, reject_note = $3, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [id, reason, note]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
    (async () => {
      try {
        const mailer = require('../utils/mailer');
        if (rows[0].email) await mailer.sendEmail({ to: rows[0].email,
          subject: 'Update on your FlowGuard provider application',
          html: `<p>Thank you for applying to join FlowGuard as a Service Provider.</p>`
              + `<p>We're unable to approve <b>${rows[0].name}</b> at this time. Reason: <b>${REJECT_REASONS[reason]}</b>.</p>`
              + (note ? `<p>${note}</p>` : '')
              + `<p>You're welcome to address this and re-apply, or reply to this email with any questions.</p>` });
      } catch (e) { console.error('[sp reject] mail', e.message); }
    })();
    return res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST reject', err); return res.status(500).json({ success: false, error: 'Failed to reject' }); }
});

// ── property assignments (tenancy) — staff manage which properties an SPO may operate on ──

// GET /service-providers/:id/properties  → assigned properties for an org
router.get('/:id/properties', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { rows } = await pool.query(
      `SELECT p.property_id, p.property_name, p.property_type, p.city, p.state,
              a.assigned_at, a.assigned_by
         FROM service_provider_property_assignments a
         JOIN properties p ON p.property_id = a.property_id
        WHERE a.service_provider_org_id = $1 AND a.active = TRUE
        ORDER BY a.assigned_at DESC`, [id]);
    return res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /:id/properties', err); return res.status(500).json({ success: false, error: 'Failed to load assignments' }); }
});

// POST /service-providers/:id/properties  body:{ property_id }  → assign
router.post('/:id/properties', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const propertyId = (req.body && req.body.property_id) || null;
    if (!Number.isInteger(id) || !propertyId) return res.status(400).json({ success: false, error: 'Org id and property_id required' });
    const org = (await pool.query('SELECT id, status FROM service_provider_organisations WHERE id = $1', [id])).rows[0];
    if (!org) return res.status(404).json({ success: false, error: 'Provider not found' });
    const prop = (await pool.query('SELECT property_id FROM properties WHERE property_id = $1', [propertyId])).rows[0];
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });
    const { rows } = await pool.query(
      `INSERT INTO service_provider_property_assignments (service_provider_org_id, property_id, assigned_by, active)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (service_provider_org_id, property_id)
       DO UPDATE SET active = TRUE, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()
       RETURNING *`, [id, propertyId, req.user.id]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST /:id/properties', err); return res.status(500).json({ success: false, error: 'Failed to assign property' }); }
});

// DELETE /service-providers/:id/properties/:propertyId  → unassign (soft)
router.delete('/:id/properties/:propertyId', requireStaff, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    await pool.query(
      `UPDATE service_provider_property_assignments SET active = FALSE
        WHERE service_provider_org_id = $1 AND property_id = $2`, [id, req.params.propertyId]);
    return res.json({ success: true });
  } catch (err) { console.error('DELETE /:id/properties', err); return res.status(500).json({ success: false, error: 'Failed to unassign' }); }
});

module.exports = router;
