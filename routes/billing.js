// Billing — invoices + summary (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { logAction } = require('../utils/audit');
const router = express.Router();

// GET /billing/summary — company-wide revenue/MRR. Ops only.
router.get('/summary', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const mrr = await pool.query(`SELECT COALESCE(SUM(mrr),0) v FROM clients`);
    const overdue = await pool.query(
      `SELECT COUNT(*) c, COALESCE(SUM(balance_due),0) amt FROM invoices
       WHERE payment_status IN ('pending','partial','overdue') AND due_date < CURRENT_DATE`);
    const paid = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) v FROM invoices WHERE payment_status='paid'`);
    const mrrVal = parseFloat(mrr.rows[0].v) || 0;
    // simple 6-month trend from paid invoices
    const trend = await pool.query(`
      SELECT to_char(date_trunc('month', paid_date), 'Mon') AS label,
             SUM(total_amount) AS amount
      FROM invoices WHERE payment_status='paid' AND paid_date > CURRENT_DATE - INTERVAL '6 months'
      GROUP BY date_trunc('month', paid_date) ORDER BY date_trunc('month', paid_date)`);
    res.json({ success: true, data: {
      mrr: mrrVal,
      arr: mrrVal * 12,
      overdue_count: parseInt(overdue.rows[0].c) || 0,
      overdue_amount: parseFloat(overdue.rows[0].amt) || 0,
      collected: parseFloat(paid.rows[0].v) || 0,
      mrr_trend: trend.rows,
    }});
  } catch (err) { console.error('GET /billing/summary', err); res.status(500).json({ success:false, error:'Failed to load billing summary' }); }
});

// GET /billing/invoices
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    // Client-role users only see their own invoices; ops see all.
    const { isClient } = require('../utils/scope');
    const clientFilter = isClient(req) ? ' WHERE i.user_id = $1' : '';
    const params = isClient(req) ? [req.user.id] : [];
    const { rows } = await pool.query(`
      SELECT i.*, u.full_name AS client_name, u.email AS client_email,
             p.property_name,
             CASE WHEN i.due_date < CURRENT_DATE AND i.payment_status != 'paid'
                  THEN (CURRENT_DATE - i.due_date) ELSE 0 END AS days_overdue
      FROM invoices i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN properties p ON i.property_id = p.property_id${clientFilter}
      ORDER BY i.created_at DESC`, params);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET /billing/invoices', err); res.status(500).json({ success:false, error:'Failed to load invoices' }); }
});

// POST /billing/invoices — create an invoice (ops-only). Client is derived from
// the property (invoices carry user_id, resolved via property.user_id), not
// entered by hand. line_items is a jsonb array of {description, qty, unit_price, amount}.
router.post('/invoices', authenticateToken, requireRole('admin', 'super_admin', 'finance', 'operations_manager'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.property_id) return res.status(400).json({ success: false, error: 'property_id is required' });
    const pr = await pool.query('SELECT user_id FROM properties WHERE property_id = $1', [b.property_id]);
    if (!pr.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    const userId = pr.rows[0].user_id;

    const items = Array.isArray(b.line_items) ? b.line_items.filter(l => l && (l.description || l.amount)) : [];
    const subtotal = items.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const total = b.total_amount != null ? Number(b.total_amount) : subtotal;
    // Normalise the form's status vocab to the values the rest of the app queries.
    let payStatus = String(b.payment_status || 'pending').toLowerCase();
    if (payStatus === 'unpaid') payStatus = 'pending';
    const status = String(b.status || 'open').toLowerCase();
    const balanceDue = payStatus === 'paid' ? 0
      : (b.balance_due != null ? Number(b.balance_due) : total);
    const invoiceId = 'INV-' + new Date().getFullYear() + '-' +
      String(Math.floor(1000 + Math.random() * 9000));

    const { rows } = await pool.query(
      `INSERT INTO invoices
         (invoice_id, property_id, user_id, invoice_type, subtotal, total_amount, balance_due,
          amount_paid, payment_status, status, issue_date, due_date, line_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [invoiceId, b.property_id, userId, b.invoice_type || 'maintenance',
       subtotal, total, balanceDue, total - balanceDue, payStatus, status,
       b.issue_date || new Date().toISOString().slice(0, 10),
       b.due_date || null, JSON.stringify(items)]);

    logAction(req.user.id, 'created an invoice', 'invoice', invoiceId, { total, property_id: b.property_id });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /billing/invoices', err);
    res.status(500).json({ success: false, error: 'Failed to create invoice' });
  }
});

// GET /billing/invoices/:id — a client may only fetch their own invoice.
router.get('/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, u.full_name AS client_name, p.property_name, p.client_id AS prop_client_id,
             (SELECT COUNT(*) FROM tickets t
                WHERE t.property_id = i.property_id
                  AND t.status NOT IN ('resolved','closed','cancelled')) AS open_tickets,
             (SELECT json_build_object(
                       'quote_id', q.quote_id, 'selected_packages', q.selected_packages,
                       'is_latest', q.is_latest, 'total_monthly', q.total_monthly)
                FROM service_quotes q WHERE q.property_id = i.property_id
                ORDER BY q.is_latest DESC NULLS LAST, q.created_at DESC LIMIT 1) AS quote
      FROM invoices i LEFT JOIN users u ON i.user_id=u.id
      LEFT JOIN properties p ON i.property_id=p.property_id
      WHERE i.invoice_id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Invoice not found' });
    if (isClient(req) && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Not authorised' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to load invoice' }); }
});

// POST /billing/invoices/:id/mark-paid — this waives a real balance; restrict
// to roles that actually handle money.
router.post('/invoices/:id/mark-paid', authenticateToken, requireRole('admin', 'super_admin', 'finance', 'operations_manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET payment_status='paid', status='paid', paid_date=CURRENT_DATE,
         amount_paid=total_amount, balance_due=0, updated_at=NOW()
       WHERE invoice_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Invoice not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to mark paid' }); }
});

// POST /billing/invoices/:id/send-reminder
router.post('/invoices/:id/send-reminder', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET reminder_sent_count = COALESCE(reminder_sent_count,0)+1,
         last_reminder_sent=NOW(), updated_at=NOW()
       WHERE invoice_id=$1 RETURNING reminder_sent_count`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Invoice not found' });
    // (email integration would fire here)
    res.json({ success: true, data: { reminded: true, count: rows[0].reminder_sent_count } });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to send reminder' }); }
});

// GET /billing/:propertyId — per-property billing (CLIENT PORTAL)
// Returns { subscription, sla, payment_history } shape
router.get('/:propertyId', authenticateToken, async (req, res) => {
  try {
    const pid = req.params.propertyId;
    const prop = await pool.query('SELECT * FROM properties WHERE property_id = $1', [pid]);
    if (!prop.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    const property = prop.rows[0];
    if (isClient(req) && property.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Not authorised' });
    }

    // latest quote drives subscription pricing
    const quote = await pool.query(
      `SELECT * FROM service_quotes WHERE property_id=$1 AND is_latest=true ORDER BY created_at DESC LIMIT 1`, [pid]);
    const q = quote.rows[0];

    // linked client (if deployed) for SLA + tier/mrr
    let client = null;
    if (property.client_id) {
      const c = await pool.query('SELECT * FROM clients WHERE id=$1', [property.client_id]);
      client = c.rows[0] || null;
    }

    // payment history from this property's invoices
    const inv = await pool.query(
      `SELECT invoice_id, total_amount AS amount, currency, payment_status AS status,
              paid_date AS paid_at, invoice_type, created_at
       FROM invoices WHERE property_id=$1 ORDER BY created_at DESC`, [pid]);

    const monthly = q ? Number(q.total_monthly) : (client ? Number(client.mrr) : null);

    const subscription = {
      plan: client ? (client.tier ? client.tier[0].toUpperCase() + client.tier.slice(1) : 'Standard') : 'Pending',
      status: property.status === 'active' ? 'active' : property.status,
      amount: monthly || 0,
      currency: 'NGN',
      billing_cycle: 'monthly',
      next_billing_date: null,
      started_at: property.deployed_at || property.created_at,
    };

    const sla = {
      uptime_guarantee: 98.0,
      current_uptime: client ? 99.0 : 0,
      response_time_hours: 2,
      avg_response_hours: 1.5,
      incidents_resolved: 0,
      incidents_total: 0,
    };

    res.json({ success: true, data: {
      subscription,
      sla,
      payment_history: inv.rows,
    }});
  } catch (err) {
    console.error('GET /billing/:propertyId', err);
    res.status(500).json({ success: false, error: 'Failed to load billing' });
  }
});

module.exports = router;
