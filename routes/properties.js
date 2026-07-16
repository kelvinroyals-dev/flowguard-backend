// Properties (submitted areas / onboarding entry) — ops + client
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient, clientIdsForUser, propertyIdsForUser } = require('../utils/scope');
const { logAction } = require('../utils/audit');
const router = express.Router();

// Shared ownership guard for the many /:propertyId/* routes below: a client
// may only reach a property they own; ops roles may reach any property.
// Writes `res` itself and returns null on failure so callers can
// `const owner = await assertPropertyAccess(...); if (!owner) return;`
async function assertPropertyAccess(req, res, pid) {
  const { rows } = await pool.query('SELECT user_id FROM properties WHERE property_id = $1', [pid]);
  if (!rows[0]) { res.status(404).json({ success: false, error: 'Property not found' }); return null; }
  if (isClient(req) && rows[0].user_id !== req.user.id) {
    res.status(403).json({ success: false, error: 'Not authorised' });
    return null;
  }
  return rows[0];
}

// camelCase (frontend) -> snake_case (db) map for property submission
const FIELD_MAP = {
  propertyName: 'property_name', propertyType: 'property_type',
  addressLine1: 'address_line1', addressLine2: 'address_line2',
  city: 'city', state: 'state', postalCode: 'postal_code', country: 'country',
  latitude: 'latitude', longitude: 'longitude',
  totalAreaSqm: 'total_area_sqm', totalAreaHectares: 'total_area_hectares',
  numberOfUnits: 'number_of_units', numberOfBuildings: 'number_of_buildings',
  estimatedPopulation: 'estimated_population',
  issueDescription: 'issue_description',
  contactPersonName: 'contact_person_name', contactPersonRole: 'contact_person_role',
  contactPhone: 'contact_phone', contactEmail: 'contact_email',
  preferredInspectionDate: 'preferred_inspection_date',
  preferredInspectionTime: 'preferred_inspection_time',
  urgencyLevel: 'urgency_level',
};

// GET /properties/all — every property across all clients (ops view)
router.get('/all', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(`
      SELECT p.property_id, p.property_name, p.property_type, p.city, p.state, p.country,
             p.latitude, p.longitude, p.status, p.urgency_level, p.risk_level, p.health_score, p.created_at,
             p.number_of_units, p.number_of_buildings,
             u.full_name AS client_name, u.email AS client_email,
             i.status AS inspection_status, i.scheduled_date AS inspection_date,
             -- Devices: Sentinels covering this property (via sentinel_coverage)
             (SELECT COUNT(*) FROM sentinel_coverage sc WHERE sc.property_id = p.property_id) AS sentinel_count,
             -- Assets that sit under this property
             (SELECT COUNT(*) FROM properties a WHERE a.parent_property_id = p.property_id AND a.asset_class = 'drainage_asset') AS asset_count,
             -- Open incidents on this property
             (SELECT COUNT(*) FROM alerts al WHERE al.property_id = p.property_id AND al.status = 'active') AS open_incidents,
             -- SLA: latest monthly compliance for the property's client, as a short label
             (SELECT ROUND(st.uptime_percentage)::text || '%' FROM sla_tracking st WHERE st.client_id = p.client_id ORDER BY st.month DESC LIMIT 1) AS sla
      FROM properties p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT status, scheduled_date FROM inspections
        WHERE property_id = p.property_id ORDER BY created_at DESC LIMIT 1
      ) i ON true
      WHERE p.asset_class = 'customer_property' OR p.asset_class IS NULL
      ORDER BY
        CASE WHEN p.status='submitted' THEN 1 WHEN p.status='active' THEN 3 ELSE 2 END,
        p.created_at DESC
    `);
    res.json({
      success: true,
      data: rows,
      summary: {
        total: rows.length,
        submitted: rows.filter(r => r.status === 'submitted').length,
        active: rows.filter(r => r.status === 'active').length,
      },
    });
  } catch (err) {
    console.error('GET /properties/all', err);
    res.status(500).json({ success: false, error: 'Failed to load properties' });
  }
});

// GET /properties — current user's own properties (client portal)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');

    // A client sees only their own properties. Ops sees every customer
    // property — the old query filtered ops users to properties they had
    // personally registered, which is why the ops list looked empty.
    const where = ["p.asset_class = 'customer_property'"];
    const vals = [];
    if (isClient(req)) { vals.push(req.user.id); where.push(`p.user_id = $${vals.length}`); }

    const { rows } = await pool.query(`
      SELECT p.*,
             COALESCE(a.asset_count, 0)    AS asset_count,
             COALESCE(a.monitored, 0)      AS monitored_assets,
             COALESCE(a.sentinel_count, 0) AS sentinel_count,
             h.score AS health_score
        FROM properties p
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS asset_count,
                 COUNT(*) FILTER (WHERE cov.n > 0) AS monitored,
                 COALESCE(SUM(cov.n), 0) AS sentinel_count
            FROM properties ast
            LEFT JOIN LATERAL (
              SELECT COUNT(DISTINCT sc.sensor_id) AS n
                FROM sentinel_coverage sc WHERE sc.property_id = ast.property_id
            ) cov ON true
           WHERE ast.parent_property_id = p.property_id
             AND ast.asset_class = 'drainage_asset'
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT score FROM health_history
           WHERE property_id = p.property_id
           ORDER BY recorded_at DESC LIMIT 1
        ) h ON true
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC`, vals);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /properties', err);
    res.status(500).json({ success: false, error: 'Failed to load properties' });
  }
});

// POST /properties — submit a new area (client portal). Accepts camelCase + currentIssues.
router.post('/', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};

    // Build the column/value set from whatever the client sent
    const cols = ['property_id', 'user_id'];
    const propId = 'PROP-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);
    const vals = [propId, req.user.id];
    const provided = {};
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      if (body[camel] !== undefined && body[camel] !== '') {
        cols.push(snake); vals.push(body[camel]); provided[snake] = body[camel];
      }
    }

    // ── Guard NOT NULL columns so a missing field returns a clean 400,
    //    not a 500 crash (Postgres 23502). ──
    if (!provided.property_name) {
      return res.status(400).json({ success: false, error: 'Property/area name is required.' });
    }
    // property_type: normalize to a valid enum value (schema CHECK constraint 23514).
    // The form may send "residential estate" (space) or a label; map it.
    const TYPE_VALUES = ['residential_estate','commercial_complex','industrial_park','mixed_use','individual_building'];
    let ptype = (provided.property_type || 'residential_estate').toString().trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!TYPE_VALUES.includes(ptype)) ptype = 'residential_estate';
    if (provided.property_type) {
      const idx = cols.indexOf('property_type');
      vals[idx] = ptype;
    } else {
      cols.push('property_type'); vals.push(ptype);
    }
    provided.property_type = ptype;
    // city / state: fall back to a placeholder rather than crash (UI may only collect an area)
    if (!provided.city)  { cols.push('city');  vals.push(provided.address_line1 || 'Unspecified'); provided.city = 'Unspecified'; }
    if (!provided.state) { cols.push('state'); vals.push('Lagos'); provided.state = 'Lagos'; }
    // address_line1 is NOT NULL — if the form didn't collect a street address,
    // fall back to the area/city/name so the row is still valid.
    if (!provided.address_line1) {
      const fallback = provided.city || provided.property_name;
      cols.push('address_line1'); vals.push(fallback);
    }

    if (body.currentIssues) { cols.push('current_issues'); vals.push(JSON.stringify(body.currentIssues)); }
    const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO properties (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals);
    // auto-create a pending inspection
    await pool.query(
      `INSERT INTO inspections (inspection_id, property_id, status)
       VALUES ($1, $2, 'pending')`,
      ['INSP-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100), propId]);

    // fire-and-forget: confirm to submitter + alert ops
    (async () => {
      try {
        const mailer = require('../utils/mailer');
const { logAction } = require('../utils/audit');
        const owner = await pool.query('SELECT email, full_name FROM users WHERE id=$1', [req.user.id]);
        const u = owner.rows[0];
        if (u) await mailer.sendPropertyReceived(u.email, u.full_name, rows[0].property_name, rows[0].property_id);
        logAction(req.user.id, 'registered a new property', 'property', rows[0].property_id, { property_name: rows[0].property_name });
        await mailer.sendOpsNewProperty(rows[0], u ? u.full_name : null);
      } catch (e) { console.error('[properties] email error:', e.message); }
    })();

    // resolve the address to coordinates in the background — the ops map and
    // the per-property flood forecast are both dead without this
    (async () => {
      try { await require('../utils/geocode').geocodeProperty(pool, rows[0].property_id); }
      catch (e) { console.error('[properties] geocode error:', e.message); }
    })();

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /properties', err);
    res.status(500).json({ success: false, error: 'Failed to submit property' });
  }
});

// GET /properties/:propertyId — single (varchar property_id) with owning client details
// ══════════════════════════════════════════════════════════════
//  NOTE ON ROUTE ORDER
//  These STATIC routes must be declared before any '/:propertyId'
//  route. Express matches in declaration order, so '/assets' would
//  otherwise be captured as propertyId="assets" and 404.
// ══════════════════════════════════════════════════════════════

router.get('/assets', authenticateToken, async (req, res) => {
  try {
    const { isClient, clientIdsForUser } = require('../utils/scope');
    const where = [], vals = [];

    if (isClient(req)) {
      const ids = await clientIdsForUser(req.user.id);
      if (!ids.length) return res.json({ success: true, data: [] });
      vals.push(ids);
      where.push(`(p.client_id = ANY($${vals.length}) OR par.client_id = ANY($${vals.length}))`);
    }
    if (req.query.parent) { vals.push(req.query.parent); where.push(`p.parent_property_id = $${vals.length}`); }
    if (req.query.class)  { vals.push(req.query.class);  where.push(`p.asset_class = $${vals.length}`); }

    const { rows } = await pool.query(`
      SELECT p.property_id, p.asset_code, p.property_name, p.property_type, p.asset_class,
             p.parent_property_id, p.latitude, p.longitude, p.capacity_liters,
             p.risk_level, p.last_inspected_at, p.status, p.client_id,
             p.health_score, p.health_updated_at,
             par.property_name AS parent_name,
             COALESCE(cov.node_count, 0) AS node_count
        FROM properties p
        LEFT JOIN properties par ON par.property_id = p.parent_property_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS node_count FROM sentinel_coverage sc
           WHERE sc.property_id = p.property_id
        ) cov ON true
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.asset_class, p.property_name`, vals);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /properties/assets', err);
    res.status(500).json({ success: false, error: 'Failed to load assets' });
  }
});

// POST /properties/assets  (ops only) — register a drainage asset
router.post('/assets', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const b = req.body || {};
    if (!b.property_name) return res.status(400).json({ success: false, error: 'A name is required' });
    if (!DRAINAGE_TYPES.includes(b.property_type)) {
      return res.status(400).json({ success: false, error: `property_type must be one of: ${DRAINAGE_TYPES.join(', ')}` });
    }

    // an asset inherits its client (and address) from its parent property
    let parent = null;
    if (b.parent_property_id) {
      const { rows } = await pool.query(
        `SELECT * FROM properties WHERE property_id = $1`, [b.parent_property_id]);
      if (!rows.length) return res.status(400).json({ success: false, error: 'Parent property not found' });
      parent = rows[0];
    }

    const assetId = 'AST-' + Date.now().toString(36).toUpperCase();
    const { rows } = await pool.query(`
      INSERT INTO properties (
        property_id, asset_code, property_name, property_type, asset_class,
        parent_property_id, user_id, client_id,
        address_line1, city, state, country,
        latitude, longitude, capacity_liters, risk_level, status
      ) VALUES ($1,$2,$3,$4,'drainage_asset',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')
      RETURNING *`,
      [assetId, b.asset_code || null, b.property_name, b.property_type,
       b.parent_property_id || null,
       parent ? parent.user_id : req.user.id,
       b.client_id || (parent ? parent.client_id : null),
       b.address_line1 || (parent ? parent.address_line1 : 'n/a'),
       b.city  || (parent ? parent.city  : 'Lagos'),
       b.state || (parent ? parent.state : 'Lagos'),
       'Nigeria',
       b.latitude  ?? (parent ? parent.latitude  : null),
       b.longitude ?? (parent ? parent.longitude : null),
       b.capacity_liters || null, b.risk_level || null]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /properties/assets', err);
    res.status(500).json({ success: false, error: 'Failed to create asset' });
  }
});


// GET /properties/:propertyId/network
//   The hierarchy in one call: a customer property, the drainage assets
//   inside it, and the Sentinel(s) watching each asset with their latest
//   reading. This is the relationship made visible.
router.get('/:propertyId', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              u.full_name AS client_name,
              u.email     AS client_email,
              u.phone     AS client_phone
       FROM properties p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.property_id = $1`,
      [req.params.propertyId]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    if (isClient(req) && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Not authorised' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /properties/:id', err);
    res.status(500).json({ success: false, error: 'Failed to load property' });
  }
});

// NOTE: the PUT /:propertyId handler used to be duplicated here. Express only
// ever dispatches to the FIRST matching route registration, so this earlier
// copy silently shadowed the ownership-checked version further down in this
// file — that second copy was dead code. Removed; see the single remaining
// PUT /:propertyId handler below for the real (guarded) implementation.

// GET /properties/:propertyId/inspection — latest inspection + assigned team/agent (client visibility)
router.get('/:propertyId/inspection', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    const { rows } = await pool.query(
      `SELECT i.*,
              t.team_name        AS team_name,
              t.status           AS team_status,
              t.members          AS team_members,
              t.current_location AS team_location
       FROM inspections i
       LEFT JOIN field_teams t ON t.team_id = i.assigned_team
       WHERE i.property_id=$1
       ORDER BY i.created_at DESC LIMIT 1`,
      [req.params.propertyId]);
    res.json({ success:true, data: rows[0] || null });
  } catch (err) { console.error('GET inspection', err); res.status(500).json({ success:false, error:'Failed to load inspection' }); }
});

// GET /properties/:propertyId/invoices
router.get('/:propertyId/invoices', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    const { rows } = await pool.query(
      `SELECT * FROM invoices WHERE property_id=$1 ORDER BY created_at DESC`,
      [req.params.propertyId]);
    res.json({ success:true, data: rows });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load invoices' }); }
});

// GET /properties/:propertyId/services — quote / selected packages
router.get('/:propertyId/services', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    const { rows } = await pool.query(
      `SELECT * FROM service_quotes WHERE property_id=$1 AND is_latest=true ORDER BY created_at DESC LIMIT 1`,
      [req.params.propertyId]);
    res.json({ success:true, data: rows[0] || null });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load services' }); }
});

// POST /properties/:propertyId/select-services  body: { packages: [...] }
router.post('/:propertyId/select-services', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    const { packages } = req.body || {};
    const quoteId = 'QUOTE-' + Date.now() + '-' + Math.floor(Math.random()*900+100);
    await pool.query(`UPDATE service_quotes SET is_latest=false WHERE property_id=$1`, [req.params.propertyId]);
    const { rows } = await pool.query(
      `INSERT INTO service_quotes (quote_id, property_id, selected_packages, status, is_latest)
       VALUES ($1,$2,$3,'draft',true) RETURNING *`,
      [quoteId, req.params.propertyId, JSON.stringify(packages || [])]);
    res.status(201).json({ success:true, data: rows[0] });
  } catch (err) { console.error('POST select-services', err); res.status(500).json({ success:false, error:'Failed to select services' }); }
});

// GET /properties/:propertyId/alerts
router.get('/:propertyId/alerts', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    // alerts tie to client_id/sensor; for a submitted property there may be none yet
    const { rows } = await pool.query(
      `SELECT a.* FROM alerts a
       JOIN properties p ON p.client_id = a.client_id
       WHERE p.property_id = $1 AND a.status != 'closed'
       ORDER BY a.created_at DESC`, [req.params.propertyId]);
    res.json({ success:true, data: rows });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load property alerts' }); }
});

// GET /properties/:propertyId/tickets — support tickets for a property
router.get('/:propertyId/tickets', authenticateToken, async (req, res) => {
  try {
    const owner = await assertPropertyAccess(req, res, req.params.propertyId);
    if (!owner) return;
    const { rows } = await pool.query(
      `SELECT * FROM tickets WHERE property_id = $1 ORDER BY created_at DESC`,
      [req.params.propertyId]);
    const data = rows.map(r => ({
      ticket_id: r.ticket_id, id: r.ticket_id,
      subject: r.title, title: r.title, description: r.description,
      type: r.category || 'general', priority: r.priority || 'normal',
      status: r.status, property_id: r.property_id, created_at: r.created_at,
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /properties/:id/tickets', err);
    res.status(500).json({ success: false, error: 'Failed to load tickets' });
  }
});

// POST /properties/:propertyId/schedule-inspection — ops dispatches a field
// team; a client submitting their own inspection date is not this endpoint.
// body: { scheduled_date, team_id, notes, priority }
router.post('/:propertyId/schedule-inspection', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const pid = req.params.propertyId;
    const b = req.body || {};
    if (!b.scheduled_date) {
      return res.status(400).json({ success: false, error: 'Scheduled date is required' });
    }
    // Verify property exists
    const prop = await pool.query('SELECT property_id FROM properties WHERE property_id = $1', [pid]);
    if (!prop.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });

    // Reuse an existing pending inspection if present, else create one
    const existing = await pool.query(
      `SELECT inspection_id FROM inspections WHERE property_id=$1 AND status IN ('pending','rescheduled') ORDER BY created_at DESC LIMIT 1`,
      [pid]);

    let inspection;
    if (existing.rows[0]) {
      const upd = await pool.query(
        `UPDATE inspections SET scheduled_date=$1, assigned_team=$2, status='scheduled', updated_at=NOW()
         WHERE inspection_id=$3 RETURNING *`,
        [b.scheduled_date, b.team_id || null, existing.rows[0].inspection_id]);
      inspection = upd.rows[0];
    } else {
      const inspId = 'INSP-' + Date.now() + '-' + Math.floor(Math.random()*900+100);
      const ins = await pool.query(
        `INSERT INTO inspections (inspection_id, property_id, scheduled_date, assigned_team, status)
         VALUES ($1,$2,$3,$4,'scheduled') RETURNING *`,
        [inspId, pid, b.scheduled_date, b.team_id || null]);
      inspection = ins.rows[0];
    }

    // Advance the property's pipeline status
    await pool.query(
      `UPDATE properties SET status='inspection_scheduled', updated_at=NOW() WHERE property_id=$1`, [pid]);
    logAction(req.user.id, 'scheduled an inspection', 'property', pid, { scheduled_date: b.scheduled_date });
    pool.query(`INSERT INTO property_events (property_id, event_type, description, created_by) VALUES ($1,'inspection','Inspection scheduled',$2)`, [pid, req.user.id]).catch(()=>{});

    // notify the property owner of the status change (fire-and-forget)
    (async () => {
      try {
        const mailer = require('../utils/mailer');
        const info = await pool.query(
          `SELECT p.property_name, u.email, u.full_name
           FROM properties p JOIN users u ON u.id = p.user_id WHERE p.property_id=$1`, [pid]);
        const r = info.rows[0];
        if (r && r.email) await mailer.sendStatusUpdate(r.email, r.full_name, r.property_name, 'inspection_scheduled', pid);
      } catch (e) { console.error('[schedule-inspection] email error:', e.message); }
    })();

    res.status(201).json({ success: true, data: inspection });
  } catch (err) {
    console.error('POST /properties/:id/schedule-inspection', err);
    res.status(500).json({ success: false, error: 'Failed to schedule inspection' });
  }
});

// POST /properties/:propertyId/generate-invoice — ops bills the customer;
// a client account must never be able to create its own invoice.
// body: { amount, description }
router.post('/:propertyId/generate-invoice', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const pid = req.params.propertyId;
    const b = req.body || {};
    const amount = parseFloat(b.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'A positive amount is required' });
    }
    const prop = await pool.query('SELECT property_id, user_id FROM properties WHERE property_id=$1', [pid]);
    if (!prop.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });

    const invoiceId = 'INV-' + Date.now() + '-' + Math.floor(Math.random()*900+100);
    const { rows } = await pool.query(
      `INSERT INTO invoices
        (invoice_id, property_id, user_id, invoice_type, subtotal, total_amount, balance_due,
         payment_status, status, issue_date, due_date, line_items)
       VALUES ($1,$2,$3,'monthly',$4,$4,$4,'pending','sent',CURRENT_DATE,CURRENT_DATE + INTERVAL '14 days',$5)
       RETURNING *`,
      [invoiceId, pid, prop.rows[0].user_id, amount,
       JSON.stringify([{ description: b.description || 'FlowGuard Service Fee', amount }])]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /properties/:id/generate-invoice', err);
    res.status(500).json({ success: false, error: 'Failed to generate invoice' });
  }
});


// PUT /properties/:propertyId — client updates their own property records; ops can update any
router.put('/:propertyId', authenticateToken, async (req, res) => {
  try {
    const pid = req.params.propertyId;
    const body = req.body || {};
    const { isClient } = require('../utils/scope');

    // ownership check
    const { rows: own } = await pool.query('SELECT user_id FROM properties WHERE property_id=$1', [pid]);
    if (!own[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    if (isClient(req) && own[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Not authorised to edit this property' });
    }

    // build SET from FIELD_MAP; empty string = clear to NULL
    const sets = [];
    const vals = [];
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      if (body[camel] !== undefined) {
        let v = body[camel] === '' ? null : body[camel];
        if (snake === 'property_type' && v) {
          const TYPE_VALUES = ['residential_estate','commercial_complex','industrial_park','mixed_use','individual_building'];
          v = v.toString().trim().toLowerCase().replace(/[\s-]+/g, '_');
          if (!TYPE_VALUES.includes(v)) v = 'residential_estate';
        }
        sets.push(`${snake}=$${vals.length + 1}`);
        vals.push(v);
      }
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update' });
    // never allow clearing NOT NULL columns
    for (const nn of ['property_name','city','state','address_line1']) {
      const i = sets.findIndex(x => x.startsWith(nn + '='));
      if (i >= 0 && vals[i] === null) { sets.splice(i, 1); vals.splice(i, 1); }
    }
    vals.push(pid);
    const { rows } = await pool.query(
      `UPDATE properties SET ${sets.join(', ')}, updated_at=NOW() WHERE property_id=$${vals.length} RETURNING *`, vals);
    logAction(req.user.id, 'updated property details', 'property', pid, { property_name: rows[0] && rows[0].property_name });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /properties/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update property' });
  }
});


// GET /properties/:propertyId/outcomes — the value narrative (events + protection stats)
router.get('/:propertyId/outcomes', authenticateToken, async (req, res) => {
  try {
    const pid = req.params.propertyId;
    const { isClient } = require('../utils/scope');
    const { rows: own } = await pool.query('SELECT user_id, created_at FROM properties WHERE property_id=$1', [pid]);
    if (!own[0]) return res.status(404).json({ success:false, error:'Property not found' });
    if (isClient(req) && own[0].user_id !== req.user.id) return res.status(403).json({ success:false, error:'Not authorised' });

    const { rows: counts } = await pool.query(`
      SELECT event_type, COUNT(*)::int AS n, MAX(occurred_at) AS last
      FROM property_events WHERE property_id=$1 GROUP BY event_type`, [pid]);
    const by = {}; counts.forEach(c => by[c.event_type] = c);
    const { rows: recent } = await pool.query(`
      SELECT event_type, description, occurred_at FROM property_events
      WHERE property_id=$1 ORDER BY occurred_at DESC LIMIT 10`, [pid]);
    const lastFlood = by.flood_incident ? by.flood_incident.last : null;
    const sinceDate = lastFlood || own[0].created_at;
    const daysSince = Math.floor((Date.now() - new Date(sinceDate).getTime()) / 864e5);
    res.json({ success: true, data: {
      protected_since: own[0].created_at,
      days_since_flood: daysSince,
      flood_free_basis: lastFlood ? 'last_incident' : 'monitoring_start',
      clearings: (by.silt_clearing && by.silt_clearing.n) || 0,
      dispatches: (by.dispatch && by.dispatch.n) || 0,
      refills: (by.enzyme_refill && by.enzyme_refill.n) || 0,
      incidents_prevented: (by.incident_prevented && by.incident_prevented.n) || 0,
      maintenance_visits: ((by.maintenance && by.maintenance.n) || 0) + ((by.node_repair && by.node_repair.n) || 0),
      recent_events: recent
    }});
  } catch (err) { console.error('GET outcomes', err); res.status(500).json({ success:false, error:'Failed to load outcomes' }); }
});

// GET /properties/:propertyId/health-history?days=90 — score trend series
router.get('/:propertyId/health-history', authenticateToken, async (req, res) => {
  try {
    const pid = req.params.propertyId;
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const { isClient } = require('../utils/scope');
    const { rows: own } = await pool.query('SELECT user_id FROM properties WHERE property_id=$1', [pid]);
    if (!own[0]) return res.status(404).json({ success:false, error:'Property not found' });
    if (isClient(req) && own[0].user_id !== req.user.id) return res.status(403).json({ success:false, error:'Not authorised' });
    const { rows } = await pool.query(`
      SELECT score, components, recorded_at FROM health_history
      WHERE property_id=$1 AND recorded_at >= CURRENT_DATE - $2::int
      ORDER BY recorded_at ASC`, [pid, days]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET health-history', err); res.status(500).json({ success:false, error:'Failed to load health history' }); }
});

// POST /properties/:propertyId/events — ops records a value event (clearing done, incident prevented, etc.)
router.post('/:propertyId/events', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success:false, error:'Ops only' });
    const { event_type, description, metadata, occurred_at } = req.body || {};
    if (!event_type) return res.status(400).json({ success:false, error:'event_type is required' });
    const { rows } = await pool.query(`
      INSERT INTO property_events (property_id, event_type, description, metadata, occurred_at, created_by)
      VALUES ($1,$2,$3,$4,COALESCE($5, NOW()),$6) RETURNING *`,
      [req.params.propertyId, event_type, description || null, metadata ? JSON.stringify(metadata) : null, occurred_at || null, req.user.id]);
    logAction(req.user.id, `recorded: ${event_type.replace(/_/g,' ')}`, 'property', req.params.propertyId, { description });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST events', err); res.status(500).json({ success:false, error:'Failed to record event' }); }
});


// ══════════════════════════════════════════════════════════════
//  ASSET REGISTRY — drainage infrastructure under a customer property
//  Canals, catch basins, culverts, pump stations: the things a Sentinel
//  is bolted to, the things that flood, the things with a health score.
// ══════════════════════════════════════════════════════════════

const DRAINAGE_TYPES = [
  'primary_canal','secondary_drain','box_culvert','storm_drain','catch_basin',
  'manhole','retention_pond','pump_station','flood_gate','overflow_chamber',
  'detention_tank','outfall',
];

// GET /properties/assets?parent=PROP-123&class=drainage_asset
router.get('/:propertyId/network', authenticateToken, async (req, res) => {
  try {
    const { isClient, clientIdsForUser, propertyIdsForUser } = require('../utils/scope');

    // tenancy: a client may only open their own property
    if (isClient(req)) {
      const mine = await propertyIdsForUser(req.user.id);
      if (!mine.includes(req.params.propertyId)) {
        return res.status(403).json({ success: false, error: 'Not authorised' });
      }
    }

    const { rows: pRows } = await pool.query(
      `SELECT * FROM properties WHERE property_id = $1`, [req.params.propertyId]);
    if (!pRows.length) return res.status(404).json({ success: false, error: 'Property not found' });
    const property = pRows[0];

    // Commercial context for the mission-control header (MRR, tier). Best
    // effort only — properties.client_id may not resolve to a clients row
    // (older data, or a property not yet tied to a billing account), and
    // that's fine: the frontend shows "—" rather than a fabricated number.
    let billing = null;
    if (property.client_id) {
      const { rows: cRows } = await pool.query(
        `SELECT name, tier, mrr FROM clients WHERE id = $1`, [property.client_id]);
      billing = cRows[0] || null;
    }

    // assets inside this property, each with the Sentinels covering it
    const { rows: assets } = await pool.query(`
      SELECT a.property_id, a.asset_code, a.property_name, a.property_type,
             a.capacity_liters, a.risk_level, a.last_inspected_at,
             a.latitude, a.longitude,
             a.health_score, a.health_updated_at,
             hh.components AS health_components,
             COALESCE(sn.sentinels, '[]'::json) AS sentinels
        FROM properties a
        LEFT JOIN LATERAL (
          SELECT components FROM health_history
           WHERE property_id = a.property_id
           ORDER BY recorded_at DESC LIMIT 1
        ) hh ON true
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
                   'sensor_id',   s.sensor_id,
                   'name',        s.name,
                   'status',      s.status,
                   'is_primary',  sc.is_primary,
                   'battery_voltage', s.battery_voltage,
                   'signal_strength', s.signal_strength,
                   'last_ping',   s.last_ping,
                   'capabilities', s.capabilities,
                   'level',       r.water_level_percent,
                   'flow_rate',   r.inflow_rate,
                   'silt_depth_mm', r.silt_depth_mm,
                   'debris',      r.debris_detected,
                   'reading_time', r.time
                 ) ORDER BY sc.is_primary DESC) AS sentinels
            FROM sentinel_coverage sc
            JOIN sensors s ON s.sensor_id = sc.sensor_id
            LEFT JOIN LATERAL (
              SELECT water_level_percent, inflow_rate, silt_depth_mm, debris_detected, time
                FROM sensor_readings WHERE sensor_id = s.sensor_id
                ORDER BY time DESC LIMIT 1
            ) r ON true
           WHERE sc.property_id = a.property_id
        ) sn ON true
       WHERE a.parent_property_id = $1 AND a.asset_class = 'drainage_asset'
       ORDER BY a.property_name`, [req.params.propertyId]);

    // Sentinels tied to this client but covering NOTHING here — a real gap worth showing
    const { rows: orphans } = await pool.query(`
      SELECT s.sensor_id, s.name, s.status
        FROM sensors s
       WHERE s.client_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM sentinel_coverage sc
             JOIN properties p ON p.property_id = sc.property_id
            WHERE sc.sensor_id = s.sensor_id
              AND (p.parent_property_id = $2 OR p.property_id = $2))`,
      [property.client_id, req.params.propertyId]);

    res.json({
      success: true,
      data: {
        property,
        billing,
        assets,
        unassigned_sentinels: orphans,
        summary: {
          asset_count: assets.length,
          monitored: assets.filter(a => (a.sentinels || []).length).length,
          unmonitored: assets.filter(a => !(a.sentinels || []).length).length,
          sentinel_count: new Set(assets.flatMap(a => (a.sentinels || []).map(s => s.sensor_id))).size,
          sentinels_active: new Set(assets.flatMap(a => (a.sentinels || []).filter(s => s.status === 'active').map(s => s.sensor_id))).size,
        },
      },
    });
  } catch (err) {
    console.error('GET /properties/:id/network', err);
    res.status(500).json({ success: false, error: 'Failed to load the property network' });
  }
});

module.exports = router;
