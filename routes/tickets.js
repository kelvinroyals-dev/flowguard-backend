// Support tickets — client portal + ops
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient } = require('../utils/scope');
const router = express.Router();
const { logAction } = require('../utils/audit');

// Shared ownership guard: a client may only reach their own ticket; ops may
// reach any. Returns the ticket row, or null after writing the response.
async function assertTicketAccess(req, res, ticketId) {
  const { rows } = await pool.query(
    'SELECT ticket_id, user_id, property_id, work_type, status, assigned_team, alert_id FROM tickets WHERE ticket_id = $1',
    [ticketId]);
  if (!rows[0]) { res.status(404).json({ success: false, error: 'Ticket not found' }); return null; }
  if (isClient(req) && rows[0].user_id !== req.user.id) {
    res.status(403).json({ success: false, error: 'Not authorised' });
    return null;
  }
  return rows[0];
}

// shape a DB row to what the frontend renders (subject/priority aliases)
function shape(r) {
  return {
    ticket_id: r.ticket_id,
    id: r.ticket_id,
    subject: r.title,
    title: r.title,
    description: r.description,
    type: r.category || 'general',
    priority: r.priority || 'normal',
    status: r.status,
    property_id: r.property_id,
    created_at: r.created_at,
  };
}

// GET /tickets — current user's tickets (all properties)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.id]);
    res.json({ success: true, data: rows.map(shape) });
  } catch (err) {
    console.error('GET /tickets', err);
    res.status(500).json({ success: false, error: 'Failed to load tickets' });
  }
});

// POST /tickets  body: { subject, description, priority, property_id, category }
router.post('/', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.subject || !b.description) {
      return res.status(400).json({ success: false, error: 'Subject and description are required' });
    }
    const ticketId = 'TKT-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);
    const { rows } = await pool.query(
      `INSERT INTO tickets (ticket_id, title, description, priority, category, property_id, user_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8) RETURNING *`,
      [ticketId, b.subject, b.description, b.priority || 'normal', b.category || null,
       b.property_id || null, req.user.id, req.user.email]);
    logAction(req.user.id, 'opened a support ticket', 'ticket', rows[0] && rows[0].ticket_id, { subject: rows[0] && rows[0].title });
    // A client raising a ticket lands in the ops notification center.
    if (isClient(req)) {
      const { notifyInternal } = require('../utils/notify');
      notifyInternal({ type: 'support', title: 'New support ticket', message: (b.subject || 'A client opened a ticket'), link: '#support/' + ticketId }, { roles: notifyInternal.SUPPORT });
    }
    res.status(201).json({ success: true, data: shape(rows[0]) });
  } catch (err) {
    console.error('POST /tickets', err);
    res.status(500).json({ success: false, error: 'Failed to create ticket' });
  }
});

// ══════════════════════════════════════════════════════════════
//  MAINTENANCE PLANNER — scheduled work, distinct from alert-triggered
//  dispatch (routes/alerts.js .../dispatch). A ticket lands here once it
//  has a work_type or an assigned crew, i.e. it's real field work, not a
//  bare client support message with nothing yet to schedule.
//  MUST be registered before GET/POST '/:ticketId' below — Express
//  dispatches to the first matching route, and ':ticketId' would swallow
//  a literal '/planner' segment otherwise (see the same note that used to
//  bite properties.js).
// ══════════════════════════════════════════════════════════════

// GET /tickets/planner — ops-only, all scheduled/active/recently-completed work
router.get('/planner', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(`
      SELECT t.ticket_id, t.title, t.priority, t.status, t.work_type,
             t.scheduled_date, t.estimated_hours, t.created_at, t.completed_at,
             t.property_id, COALESCE(p.asset_code, p.property_name) AS property_name,
             t.assigned_team, ft.team_name, ft.members
        FROM tickets t
        LEFT JOIN properties p ON p.property_id = t.property_id
        LEFT JOIN field_teams ft ON ft.team_id = t.assigned_team
       WHERE t.work_type IS NOT NULL OR t.assigned_team IS NOT NULL OR t.scheduled_date IS NOT NULL
       ORDER BY COALESCE(t.scheduled_date, t.created_at) ASC
       LIMIT 300`);
    res.json({ success: true, data: rows.map(r => ({
      ticket_id: r.ticket_id, title: r.title, priority: r.priority || 'normal',
      status: r.status, work_type: r.work_type,
      scheduled_date: r.scheduled_date, estimated_hours: r.estimated_hours != null ? parseFloat(r.estimated_hours) : null,
      created_at: r.created_at, completed_at: r.completed_at,
      property_id: r.property_id, property_name: r.property_name,
      assigned_team: r.assigned_team, team_name: r.team_name,
      crew_size: Array.isArray(r.members) ? r.members.length : null,
    })) });
  } catch (err) {
    console.error('GET /tickets/planner', err);
    res.status(500).json({ success: false, error: 'Failed to load the maintenance planner' });
  }
});

// POST /tickets/planner — schedule a new maintenance job (ops-only)
// body: { property_id, work_type, title?, priority?, assigned_team?, scheduled_date, estimated_hours? }
router.post('/planner', authenticateToken, requirePermission('maintenance.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const b = req.body || {};
    if (!b.work_type) return res.status(400).json({ success: false, error: 'work_type is required' });
    if (!b.scheduled_date) return res.status(400).json({ success: false, error: 'scheduled_date is required' });

    let propertyName = null;
    if (b.property_id) {
      const { rows } = await pool.query(
        `SELECT COALESCE(asset_code, property_name) AS name FROM properties WHERE property_id = $1`, [b.property_id]);
      propertyName = rows[0] ? rows[0].name : null;
    }
    const title = b.title || `${String(b.work_type).replace(/_/g, ' ')}${propertyName ? ' — ' + propertyName : ''}`;
    const ticketId = 'WO-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);

    const { rows } = await pool.query(`
      INSERT INTO tickets (ticket_id, title, description, priority, work_type, property_id,
                            assigned_team, scheduled_date, estimated_hours, status,
                            user_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',$10,$11) RETURNING *`,
      [ticketId, title, b.description || null, b.priority || 'normal', b.work_type,
       b.property_id || null, b.assigned_team || null, b.scheduled_date,
       b.estimated_hours || null, req.user.id, req.user.email]);

    logAction(req.user.id, 'scheduled a maintenance job', 'ticket', ticketId, { work_type: b.work_type, scheduled_date: b.scheduled_date });
    res.status(201).json({ success: true, data: shape(rows[0]) });
  } catch (err) {
    console.error('POST /tickets/planner', err);
    res.status(500).json({ success: false, error: 'Failed to schedule the job' });
  }
});

// GET /tickets/support — client-raised support tickets for the ops inbox.
// These are inquiries (no work_type / crew) — distinct from maintenance jobs,
// which is why they never showed up in the planner. Ops-only.
router.get('/support', authenticateToken, requirePermission('support.view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.ticket_id, t.title, t.description, t.category, t.priority, t.status,
             t.property_id, t.created_at, t.user_id,
             u.full_name AS client_name, u.email AS client_email,
             p.property_name,
             (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.ticket_id) AS message_count,
             (SELECT MAX(created_at) FROM ticket_messages m WHERE m.ticket_id = t.ticket_id) AS last_message_at
        FROM tickets t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN properties p ON p.property_id = t.property_id
       WHERE t.work_type IS NULL AND t.assigned_team IS NULL
       ORDER BY (t.status NOT IN ('resolved','closed')) DESC,
                COALESCE((SELECT MAX(created_at) FROM ticket_messages m WHERE m.ticket_id = t.ticket_id), t.created_at) DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /tickets/support', err);
    res.status(500).json({ success: false, error: 'Failed to load support tickets' });
  }
});

// PUT /tickets/:ticketId/support-status — resolve/reopen a support ticket from
// the ops Support inbox (gated on support.manage, separate from maintenance).
router.put('/:ticketId/support-status', authenticateToken, requirePermission('support.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  const status = ['resolved', 'in_progress', 'closed'].includes(req.body && req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ success: false, error: 'Invalid status' });
  try {
    const { rows } = await pool.query('UPDATE tickets SET status=$2, updated_at=NOW() WHERE ticket_id=$1 RETURNING ticket_id, status', [req.params.ticketId, status]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Ticket not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: 'Failed to update ticket' }); }
});

// GET /tickets/:ticketId
router.get('/:ticketId', authenticateToken, async (req, res) => {
  try {
    if (!(await assertTicketAccess(req, res, req.params.ticketId))) return;
    const { rows } = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [req.params.ticketId]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Ticket not found' });
    let messages = [];
    try {
      const m = await pool.query('SELECT author_type, author_name, message, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [req.params.ticketId]);
      messages = m.rows;
    } catch (_) { /* table may not exist yet */ }
    res.json({ success: true, data: { ...shape(rows[0]), messages } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load ticket' });
  }
});

// POST /:ticketId/reply — add a message to the ticket thread
router.post('/:ticketId/reply', authenticateToken, async (req, res) => {
  try {
    const t = await assertTicketAccess(req, res, req.params.ticketId);
    if (!t) return;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message is required' });
    const name = req.user.full_name || req.user.email || 'You';
    const { rows } = await pool.query(
      `INSERT INTO ticket_messages (ticket_id, author_type, author_name, message)
       VALUES ($1, $2, $3, $4) RETURNING author_type, author_name, message, created_at`,
      [req.params.ticketId, isClient(req) ? 'client' : 'support', name, message.trim()]);
    // reopen ticket if it was resolved/closed
    await pool.query(`UPDATE tickets SET status = CASE WHEN status IN ('resolved','closed') THEN 'in_progress' ELSE status END, updated_at = NOW() WHERE ticket_id = $1`, [req.params.ticketId]);
    // Notify the client when OPS replies (not on the client's own reply)…
    if (!isClient(req) && t.user_id) {
      require('../utils/notify').notify(t.user_id, {
        type: 'support', title: 'Support replied to your ticket',
        message: message.trim().slice(0, 140), link: '#ticket/' + req.params.ticketId,
      });
    }
    // …and notify the ops support team when the CLIENT replies.
    if (isClient(req)) {
      const { notifyInternal } = require('../utils/notify');
      notifyInternal({ type: 'support', title: 'Client replied to a ticket', message: message.trim().slice(0, 140), link: '#support/' + req.params.ticketId }, { roles: notifyInternal.SUPPORT });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /tickets/:id/reply', err);
    res.status(500).json({ success: false, error: 'Failed to add reply' });
  }
});


// POST /tickets/:ticketId/complete  { resolution_notes?, work_type? }
//   The field crew closes the job in field.html. THIS is where the client's
//   outcome record is written — no separate "log an event" chore for ops.
router.post('/:ticketId/complete', authenticateToken, requirePermission('maintenance.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT ticket_id, property_id, work_type, status, assigned_team, alert_id
         FROM tickets WHERE ticket_id = $1 FOR UPDATE`, [req.params.ticketId]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Work order not found' }); }
    const t = rows[0];
    if (['resolved', 'closed'].includes(t.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Work order already completed' });
    }

    const workType = req.body.work_type || t.work_type || 'maintenance';

    await client.query(
      `UPDATE tickets SET status='resolved', completed_at=NOW(), resolved_at=NOW(),
              resolution_notes=COALESCE($2, resolution_notes), work_type=$3
        WHERE ticket_id=$1`,
      [t.ticket_id, req.body.resolution_notes || null, workType]);

    // release the crew
    if (t.assigned_team) {
      await client.query(
        `UPDATE field_teams SET status='idle', current_ticket_id=NULL, updated_at=NOW()
          WHERE team_id=$1 AND current_ticket_id=$2`, [t.assigned_team, t.ticket_id]);
    }

    // enzyme refill actually refills the cartridge — the hardware tracks this
    if (workType === 'enzyme_refill') {
      // only the node(s) actually covering this asset — a refill is not estate-wide
      await client.query(`
        UPDATE sensors SET enzyme_level_percent = 100,
                           cartridge_status = 'loaded',
                           enzyme_installed_date = CURRENT_DATE,
                           estimated_depletion_date = CASE
                             WHEN daily_dispense_ml > 0 AND enzyme_capacity_ml > 0
                             THEN CURRENT_DATE + (enzyme_capacity_ml / daily_dispense_ml)::int
                             ELSE NULL END,
                           updated_at = NOW()
         WHERE device_variant = 'bio_dispenser'
           AND sensor_id IN (SELECT sensor_id FROM sentinel_coverage WHERE property_id = $1)`,
        [t.property_id]);
    }

    // ── the outcome the client sees ──
    // work_type maps 1:1 onto the event types the portal counts
    const EVENT_FOR = {
      silt_clearing: 'silt_clearing',
      enzyme_refill: 'enzyme_refill',
      node_repair:   'node_repair',
      inspection:    'inspection',
      maintenance:   'maintenance',
    };
    const evt = EVENT_FOR[workType] || 'maintenance';
    let eventLogged = null;
    if (t.property_id) {
      await client.query(`
        INSERT INTO property_events (property_id, event_type, description, metadata, created_by)
        VALUES ($1,$2,$3,$4,$5)`,
        [t.property_id, evt,
         req.body.resolution_notes || `${workType.replace(/_/g, ' ')} completed`,
         JSON.stringify({ ticket_id: t.ticket_id, alert_id: t.alert_id, team_id: t.assigned_team }),
         req.user.id]);
      eventLogged = evt;
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { ticket_id: t.ticket_id, work_type: workType, event_logged: eventLogged } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /tickets/:id/complete', err);
    res.status(500).json({ success: false, error: 'Failed to complete work order' });
  } finally {
    client.release();
  }
});

// PUT /tickets/:ticketId/status — move a job between planner columns
// (Scheduled <-> In Progress). Completion has real side-effects (crew
// release, client outcome record) so it stays on POST /:id/complete —
// this endpoint deliberately refuses 'resolved'/'closed'.
router.put('/:ticketId/status', authenticateToken, requirePermission('maintenance.manage'), async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const VALID = ['scheduled', 'in_progress'];
    if (!VALID.includes(req.body.status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${VALID.join(', ')}. Use POST /tickets/:id/complete to mark work done.` });
    }
    const { rows } = await pool.query(
      `UPDATE tickets SET status = $2, updated_at = NOW() WHERE ticket_id = $1 RETURNING *`,
      [req.params.ticketId, req.body.status]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Work order not found' });
    res.json({ success: true, data: shape(rows[0]) });
  } catch (err) {
    console.error('PUT /tickets/:id/status', err);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

module.exports = router;
