// Billing — invoices + summary (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient } = require('../utils/scope');
const { logAction } = require('../utils/audit');
const PDFDocument = require('pdfkit');
const fs = require('fs');
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
router.post('/invoices', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.property_id) return res.status(400).json({ success: false, error: 'property_id is required' });
    const pr = await pool.query('SELECT user_id FROM properties WHERE property_id = $1', [b.property_id]);
    if (!pr.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    const userId = pr.rows[0].user_id;

    const items = Array.isArray(b.line_items) ? b.line_items.filter(l => l && (l.description || l.amount)) : [];
    const subtotal = items.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    // VAT: default 7.5% (Nigeria), overridable per invoice.
    const vatRate = b.vat_rate != null ? Math.max(0, Number(b.vat_rate)) : 7.5;
    const vatAmount = Math.round(subtotal * vatRate) / 100;
    const total = b.total_amount != null ? Number(b.total_amount) : subtotal + vatAmount;
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
         (invoice_id, property_id, user_id, invoice_type, subtotal, vat_rate, vat_amount,
          total_amount, balance_due, amount_paid, payment_status, status, issue_date, due_date, line_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [invoiceId, b.property_id, userId, b.invoice_type || 'maintenance',
       subtotal, vatRate, vatAmount, total, balanceDue, total - balanceDue, payStatus, status,
       b.issue_date || new Date().toISOString().slice(0, 10),
       b.due_date || null, JSON.stringify(items)]);

    logAction(req.user.id, 'created an invoice', 'invoice', invoiceId, { total, property_id: b.property_id });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /billing/invoices', err);
    res.status(500).json({ success: false, error: 'Failed to create invoice' });
  }
});

// PUT /billing/invoices/:id — edit an invoice (ops-only). Recomputes VAT and
// totals from line_items + vat_rate so the stored figures stay consistent.
router.put('/invoices/:id', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await pool.query('SELECT * FROM invoices WHERE invoice_id = $1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const prev = cur.rows[0];

    const items = Array.isArray(b.line_items)
      ? b.line_items.filter(l => l && (l.description || l.amount))
      : (Array.isArray(prev.line_items) ? prev.line_items : []);
    const subtotal = items.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const vatRate = b.vat_rate != null ? Math.max(0, Number(b.vat_rate)) : Number(prev.vat_rate ?? 7.5);
    const vatAmount = Math.round(subtotal * vatRate) / 100;
    const total = subtotal + vatAmount;
    let payStatus = String(b.payment_status || prev.payment_status || 'pending').toLowerCase();
    if (payStatus === 'unpaid') payStatus = 'pending';
    const status = String(b.status || prev.status || 'open').toLowerCase();
    const balanceDue = payStatus === 'paid' ? 0 : total;

    const { rows } = await pool.query(
      `UPDATE invoices SET
         invoice_type = $2, subtotal = $3, vat_rate = $4, vat_amount = $5,
         total_amount = $6, balance_due = $7, amount_paid = $8, payment_status = $9,
         status = $10, issue_date = $11, due_date = $12, line_items = $13, updated_at = NOW()
       WHERE invoice_id = $1 RETURNING *`,
      [req.params.id, b.invoice_type || prev.invoice_type, subtotal, vatRate, vatAmount,
       total, balanceDue, total - balanceDue, payStatus, status,
       b.issue_date || prev.issue_date, b.due_date || prev.due_date, JSON.stringify(items)]);

    logAction(req.user.id, 'edited an invoice', 'invoice', req.params.id, { total });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /billing/invoices/:id', err);
    res.status(500).json({ success: false, error: 'Failed to update invoice' });
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

// Full invoice row (with property, client email, sentinel coverage) — shared by
// the PDF and send flows.
async function fetchInvoiceFull(id) {
  const { rows } = await pool.query(`
    SELECT i.*, u.full_name AS client_name, u.email AS client_email,
           p.property_name, p.address_line1, p.city, p.state,
           COALESCE(p.asset_code, p.property_id) AS property_ref,
           (SELECT array_to_json(array_agg(DISTINCT s.sensor_id))
              FROM sensors s
             WHERE s.property_id = i.property_id
                OR s.property_id IN (SELECT property_id FROM properties WHERE parent_property_id = i.property_id)
           ) AS sensor_ids
      FROM invoices i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN properties p ON i.property_id = p.property_id
     WHERE i.invoice_id = $1`, [id]);
  return rows[0] || null;
}

// Render an invoice row to a PDF Buffer. Template layout, brand colours only:
// black (structure), green (section labels / paid), red (balance due / overdue).
// Server-side pdfkit so the ₦ glyph renders via an embedded font.
function renderInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    const BLACK = '#141414', RED = '#d12b2b', GREEN = '#1f9d5b',
          GREY = '#6b7a82', LGREY = '#9aa7ad', LINE = '#e4e9ec',
          RED_T = '#fbeceb', GREEN_T = '#eaf6ef';

    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Naira-capable font if the OS ships DejaVu (Ubuntu does); else Helvetica + "NGN".
    let F = { r: 'Helvetica', b: 'Helvetica-Bold' }, NG = 'NGN ';
    try {
      const R_ = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
      const B_ = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      if (fs.existsSync(R_)) {
        doc.registerFont('body', R_);
        if (fs.existsSync(B_)) doc.registerFont('bodyB', B_);
        F = { r: 'body', b: fs.existsSync(B_) ? 'bodyB' : 'body' };
        NG = '₦';
      }
    } catch (_) { /* fall back to Helvetica + NGN */ }

    const money = n => NG + Number(n || 0).toLocaleString('en-US');
    const fmtDate = ds => ds ? new Date(ds).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const cap = s => s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '—';
    const L = 45, R = 550, W = R - L;

    // ── header (logo + company block) ──
    let tx = L;
    try {
      const logoPath = require('path').join(__dirname, '..', 'assets', 'fg-logo.png');
      if (fs.existsSync(logoPath)) { const lh = 40; doc.image(logoPath, L, 46, { height: lh }); tx = L + Math.round(lh * 834 / 620) + 12; }
    } catch (_) { /* no logo — text-only header */ }
    doc.font(F.b).fontSize(15).fillColor(BLACK).text('FlowGuard Solutions Limited', tx, 50);
    doc.font(F.r).fontSize(9).fillColor(GREY).text('Drainage & flood-prevention infrastructure', tx, 70);
    doc.fontSize(8.5).fillColor(GREY).text('support@flowguard.ng  ·  info@flowguard.ng', tx, 84);
    doc.text('020 1700 3062', tx, 96);

    doc.font(F.b).fontSize(20).fillColor(BLACK).text('INVOICE', L, 48, { width: W, align: 'right' });
    let my = 78;
    [['Invoice No.', inv.invoice_id], ['Issue date', fmtDate(inv.issue_date || inv.created_at)], ['Due date', fmtDate(inv.due_date)]].forEach(([k, v]) => {
      doc.font(F.r).fontSize(9).fillColor(GREY).text(k, R - 300, my, { width: 180, align: 'right' });
      doc.font(F.b).fontSize(9).fillColor(BLACK).text(String(v || '—'), R - 110, my, { width: 110, align: 'right' });
      my += 15;
    });
    // status badge
    const ps = String(inv.payment_status || 'pending').toLowerCase();
    const overdue = ps !== 'paid' && inv.due_date && new Date(inv.due_date) < new Date();
    const badge = ps === 'paid' ? { l: 'PAID', c: GREEN } : overdue ? { l: 'OVERDUE', c: RED } : ps === 'partial' ? { l: 'PARTIALLY PAID', c: BLACK } : { l: 'PENDING', c: BLACK };
    doc.font(F.b).fontSize(9);
    const bw = doc.widthOfString(badge.l) + 20;
    doc.roundedRect(R - bw, my + 2, bw, 18, 4).fill(badge.c);
    doc.fillColor('#ffffff').font(F.b).fontSize(9).text(badge.l, R - bw, my + 7, { width: bw, align: 'center' });

    // divider (black rule + short green brand accent)
    const hy = 150;
    doc.moveTo(L, hy).lineTo(R, hy).lineWidth(1).strokeColor(BLACK).stroke();
    doc.moveTo(L, hy).lineTo(L + 90, hy).lineWidth(2.5).strokeColor(GREEN).stroke();

    const sectionLabel = (t, x, yy) => doc.font(F.b).fontSize(8.5).fillColor(GREEN).text(t.toUpperCase(), x, yy, { characterSpacing: 0.6 });

    // ── BILL TO ──
    sectionLabel('Bill to', L, 170);
    doc.font(F.b).fontSize(11).fillColor(BLACK).text(inv.property_name || '—', L, 186, { width: 245 });
    const addr = [inv.address_line1, [inv.city, inv.state].filter(Boolean).join(', '), 'Nigeria'].filter(Boolean).join('\n');
    doc.font(F.r).fontSize(9).fillColor(GREY).text(addr || '—', L, doc.y + 2, { width: 245 });
    if (!inv.client_name)
      doc.font(F.r).fontSize(8.5).fillColor(LGREY).text('No billing contact is linked to this property yet — invoice issued against the property record only.', L, doc.y + 5, { width: 245 });
    else
      doc.font(F.r).fontSize(9).fillColor(GREY).text(inv.client_name + (inv.client_email ? '  ·  ' + inv.client_email : ''), L, doc.y + 4, { width: 245 });

    // ── INVOICE DETAILS ──
    sectionLabel('Invoice details', 315, 170);
    let dy = 188;
    const sensors = Array.isArray(inv.sensor_ids) ? inv.sensor_ids : [];
    [['Invoice type', cap(inv.invoice_type)], ['Property ref', inv.property_ref], ['Sentinel coverage', sensors.length ? sensors.join(', ') : 'None']].forEach(([k, v]) => {
      doc.font(F.r).fontSize(9).fillColor(GREY).text(k, 315, dy, { width: 95 });
      const h = doc.heightOfString(String(v || '—'), { width: 140 });
      doc.font(F.b).fontSize(9).fillColor(BLACK).text(String(v || '—'), 412, dy, { width: 138 });
      dy += Math.max(16, h + 5);
    });

    // ── line items table ──
    const items = Array.isArray(inv.line_items) ? inv.line_items : (() => { try { return JSON.parse(inv.line_items || '[]'); } catch { return []; } })();
    let ty = Math.max(275, dy + 14, doc.y + 14);
    doc.rect(L, ty, W, 22).fill(BLACK);
    doc.fillColor('#ffffff').font(F.b).fontSize(8.5);
    doc.text('DESCRIPTION', L + 8, ty + 7, { width: 250 });
    doc.text('QTY', 305, ty + 7, { width: 50, align: 'right' });
    doc.text('UNIT PRICE', 365, ty + 7, { width: 90, align: 'right' });
    doc.text('AMOUNT', 465, ty + 7, { width: 77, align: 'right' });
    let ry = ty + 22;
    (items.length ? items : [{ description: 'No line items', amount: 0 }]).forEach(it => {
      doc.font(F.r).fontSize(9).fillColor(BLACK);
      const dh = doc.heightOfString(String(it.description || '—'), { width: 250 });
      const rh = Math.max(24, dh + 14);
      doc.text(String(it.description || '—'), L + 8, ry + 7, { width: 250 });
      doc.fillColor(BLACK).text(it.qty != null ? String(it.qty) : '—', 305, ry + 7, { width: 50, align: 'right' });
      doc.text(it.unit_price != null ? money(it.unit_price) : '—', 365, ry + 7, { width: 90, align: 'right' });
      doc.font(F.b).text(money(it.amount), 465, ry + 7, { width: 77, align: 'right' });
      ry += rh;
      doc.moveTo(L, ry).lineTo(R, ry).lineWidth(0.5).strokeColor(LINE).stroke();
    });

    // ── totals ──
    let tvy = ry + 14;
    const balance = inv.balance_due != null ? Number(inv.balance_due) : Number(inv.total_amount);
    const totRow = (label, val, bold) => {
      doc.font(bold ? F.b : F.r).fontSize(9.5).fillColor(bold ? BLACK : GREY).text(label, 320, tvy, { width: 130, align: 'right' });
      doc.font(bold ? F.b : F.r).fillColor(BLACK).text(val, 460, tvy, { width: 82, align: 'right' });
      tvy += 17;
    };
    totRow('Subtotal', money(inv.subtotal != null ? inv.subtotal : inv.total_amount));
    if (Number(inv.vat_amount) > 0 || inv.vat_rate != null) totRow(`VAT (${inv.vat_rate != null ? inv.vat_rate : 7.5}%)`, money(inv.vat_amount || 0));
    totRow('Total', money(inv.total_amount), true);
    if (Number(inv.amount_paid) > 0) totRow('Amount paid', money(inv.amount_paid));
    // balance-due highlight box
    const bcol = balance > 0 ? RED : GREEN;
    doc.rect(320, tvy + 2, 222, 26).fill(balance > 0 ? RED_T : GREEN_T);
    doc.fillColor(bcol).font(F.b).fontSize(10).text('BALANCE DUE', 328, tvy + 10, { width: 120 });
    doc.text(money(balance), 440, tvy + 10, { width: 96, align: 'right' });
    tvy += 40;

    // ── footer notes ──
    let fy = Math.max(tvy + 16, 690);
    doc.font(F.r).fontSize(8.5).fillColor(GREY).text('Balance due within 30 days of the issue date. For payment queries or to confirm receipt, contact support@flowguard.ng or call 020 1700 3062.', L, fy, { width: W });
    if (ps === 'partial') doc.text('This invoice reflects a partial payment already received against the total above. A full itemized payment history is available on request.', L, doc.y + 6, { width: W });
    doc.font(F.r).fontSize(8).fillColor(LGREY).text('FlowGuard Solutions Limited  ·  Lagos, Nigeria  ·  support@flowguard.ng  ·  @theflowguards', L, 805, { width: W, align: 'center' });

    doc.end();
  });
}

// GET /billing/invoices/:id/pdf — download the invoice PDF.
router.get('/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const inv = await fetchInvoiceFull(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (isClient(req) && inv.user_id !== req.user.id) return res.status(403).json({ success: false, error: 'Not authorised' });
    const pdf = await renderInvoicePdf(inv);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_id}.pdf"`);
    res.end(pdf);
  } catch (err) {
    console.error('GET /billing/invoices/:id/pdf', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to render invoice PDF' });
  }
});

// POST /billing/invoices/:id/send — email the invoice (with PDF attached and a
// "log in to pay" CTA) to the client, and record that it was sent. Ops-only.
router.post('/invoices/:id/send', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  try {
    const inv = await fetchInvoiceFull(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (!inv.client_email) return res.status(400).json({ success: false, error: 'No client email on file — link a client to this property first.' });
    const pdf = await renderInvoicePdf(inv).catch(() => null);
    const emailed = await require('../utils/mailer').sendInvoice(
      inv.client_email, inv.client_name,
      { invoiceId: inv.invoice_id, propertyName: inv.property_name, total: inv.total_amount, balanceDue: inv.balance_due, dueDate: inv.due_date, currency: '₦' },
      pdf);
    const { rows } = await pool.query(
      `UPDATE invoices SET sent_at = NOW(), sent_count = COALESCE(sent_count,0)+1,
         status = CASE WHEN status IN ('draft','open') THEN 'sent' ELSE status END, updated_at = NOW()
       WHERE invoice_id = $1 RETURNING sent_at, sent_count`, [req.params.id]);
    logAction(req.user.id, 'sent an invoice to the client', 'invoice', req.params.id, { to: inv.client_email });
    res.json({ success: true, data: { emailed, to: inv.client_email, sent_at: rows[0].sent_at, sent_count: rows[0].sent_count } });
  } catch (err) {
    console.error('POST /billing/invoices/:id/send', err);
    res.status(500).json({ success: false, error: 'Failed to send invoice' });
  }
});

// POST /billing/invoices/:id/mark-paid — this waives a real balance; restrict
// to roles that actually handle money.
router.post('/invoices/:id/mark-paid', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET payment_status='paid', status='paid', paid_date=CURRENT_DATE,
         amount_paid=total_amount, balance_due=0, updated_at=NOW()
       WHERE invoice_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Invoice not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to mark paid' }); }
});

// POST /billing/invoices/:id/notify-payment — a client tells us they've paid.
// No payment gateway is wired, so rather than (wrongly) letting the client mark
// their own invoice paid, we raise a billing ticket for finance to reconcile —
// which surfaces in the ops Support inbox. Clients may only notify on their own.
router.post('/invoices/:id/notify-payment', authenticateToken, async (req, res) => {
  try {
    const inv = (await pool.query(
      'SELECT invoice_id, user_id, property_id, total_amount, balance_due FROM invoices WHERE invoice_id=$1',
      [req.params.id])).rows[0];
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (isClient(req) && inv.user_id !== req.user.id) return res.status(403).json({ success: false, error: 'Not authorised' });
    const note = String((req.body && req.body.note) || '').slice(0, 1000);
    const ticketId = 'TKT-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);
    const desc = `Client reports payment for ${inv.invoice_id} (balance ₦${Number(inv.balance_due || 0).toLocaleString()}). Finance to confirm receipt and mark the invoice paid.${note ? ' Client note: ' + note : ''}`;
    await pool.query(
      `INSERT INTO tickets (ticket_id, title, description, priority, category, property_id, user_id, status, created_by)
       VALUES ($1,$2,$3,'high','billing',$4,$5,'new',$6)`,
      [ticketId, 'Payment notification — ' + inv.invoice_id, desc, inv.property_id, inv.user_id, req.user.email]);
    logAction(req.user.id, 'notified a payment', 'invoice', inv.invoice_id, { ticket_id: ticketId });
    res.status(201).json({ success: true, data: { ticket_id: ticketId } });
  } catch (err) {
    console.error('POST /billing/invoices/:id/notify-payment', err);
    res.status(500).json({ success: false, error: 'Failed to send payment notification' });
  }
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
