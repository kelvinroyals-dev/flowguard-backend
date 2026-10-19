// Billing — invoices + summary (ops center)
const express = require('express');
const pool = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient,isSpUser } = require('../utils/scope');
const { invoiceAmounts } = require('../utils/invoiceAmounts');
const { randomUUID } = require('node:crypto');
const { clientCan } = require('../utils/clientPermissions');
const { logAction } = require('../utils/audit');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const router = express.Router();
router.use(authenticateToken);
router.use((req,res,next)=>isSpUser(req) ? res.status(403).json({success:false,error:'Not authorised'}) : next());
router.use(async(req,res,next)=>{
  try{
    if(isClient(req)){
      const u=(await pool.query('SELECT * FROM users WHERE id=$1 AND is_active=TRUE',[req.user.id])).rows[0];
      if(!u||u.role!=='client'||u.service_provider_org_id||!clientCan(u,'view_billing'))return res.status(403).json({success:false,error:'Not authorised'});
      if(req.method!=='GET'&&(req.path.endsWith('/notify-payment')?!clientCan(u,'manage_billing'):true))return res.status(403).json({success:false,error:'Not authorised'});
      req.billingOwnerId=u.account_owner_id||u.id;
      return next();
    }
    if(req.user.user_type!=='internal'||req.user.service_provider_org_id)return res.status(403).json({success:false,error:'Not authorised'});
    return requirePermission(req.method==='GET'?'billing.view':'billing.manage')(req,res,next);
  }catch(_){return res.status(503).json({success:false,error:'Billing access could not be verified'});}
});

// GET /billing/summary — company-wide revenue/MRR. Ops only.
router.get('/summary', authenticateToken, async (req, res) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const mrr = await pool.query(`SELECT COALESCE(SUM(mrr),0) v FROM clients`);
    const overdue = await pool.query(
      `SELECT COUNT(*) c, COALESCE(SUM(balance_due),0) amt FROM invoices
       WHERE payment_status IN ('pending','partial','overdue') AND due_date < CURRENT_DATE`);
    const paid = await pool.query(
      `SELECT currency,SUM(amount) amount FROM payments WHERE status='successful' GROUP BY currency ORDER BY currency`);
    const overdueByCurrency=await pool.query(`SELECT currency,SUM(balance_due) amount FROM invoices WHERE payment_status IN ('pending','partial','overdue') AND due_date < CURRENT_DATE GROUP BY currency ORDER BY currency`);
    const singleCurrency=rows=>rows.length===1 && /^[A-Z]{3}$/.test(String(rows[0].currency || '')) ? Number(rows[0].amount) : rows.length===0 ? 0 : null;
    const mrrVal = parseFloat(mrr.rows[0].v) || 0;
    // simple 6-month trend from paid invoices
    const trend = await pool.query(`
      SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM') AS label,
             SUM(amount) AS amount, currency
      FROM payments WHERE status='successful' AND payment_date > CURRENT_DATE - INTERVAL '6 months' AND payment_date<=NOW()
      GROUP BY date_trunc('month', payment_date),currency ORDER BY date_trunc('month', payment_date),currency`);
    res.json({ success: true, data: {
      mrr: mrrVal,
      arr: mrrVal * 12,
      mrr_currency:null,
      revenue_basis:'Recorded client MRR; currency is not supplied. ARR is its annualised value, not recognised revenue.',
      overdue_count: parseInt(overdue.rows[0].c) || 0,
      overdue_amount: singleCurrency(overdueByCurrency.rows),
      overdue_by_currency:overdueByCurrency.rows,
      collected: singleCurrency(paid.rows),
      collected_by_currency:paid.rows,
      collection_basis:'Recorded successful manual ledger entries; not independently verified bank settlement.',
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
    const params = isClient(req) ? [req.billingOwnerId] : [];
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
    if (b.currency && b.currency!=='NGN') return res.status(400).json({success:false,error:'New invoices currently use NGN; currency conversion is not supported'});
    const pr = await pool.query('SELECT user_id FROM properties WHERE property_id = $1', [b.property_id]);
    if (!pr.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    const userId = pr.rows[0].user_id;

    let amounts;
    try {amounts=invoiceAmounts(b);} catch(err) {return res.status(400).json({success:false,error:err.message});}
    const {items,subtotal,vatRate,vatAmount,total}=amounts;
    // Normalise the form's status vocab to the values the rest of the app queries.
    let payStatus = String(b.payment_status || 'pending').toLowerCase();
    if (payStatus === 'unpaid') payStatus = 'pending';
    if (payStatus!=='pending' || (b.balance_due!=null && Number(b.balance_due)!==total)) return res.status(400).json({success:false,error:'Create an unpaid invoice, then record payments through the ledger'});
    const status = String(b.status || 'open').toLowerCase();
    const balanceDue = payStatus === 'paid' ? 0
      : (b.balance_due != null ? Number(b.balance_due) : total);
    const invoiceId = 'INV-' + randomUUID();

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
    if (prev.currency!=='NGN' || (b.currency && b.currency!==prev.currency)) return res.status(409).json({success:false,error:'This invoice currency is not supported by the NGN editing workflow'});

    const paid=(await pool.query("SELECT COUNT(*)::integer n FROM payments WHERE invoice_id=$1 AND status='successful'",[req.params.id])).rows[0].n;
    if (paid>0 || Number(prev.amount_paid)>0) return res.status(409).json({success:false,error:'Invoices with recorded payments cannot be rewritten; use a separately reviewed adjustment'});
    let amounts;
    try {amounts=invoiceAmounts(b,prev);} catch(err) {return res.status(400).json({success:false,error:err.message});}
    const {items,subtotal,vatRate,vatAmount,total}=amounts;
    let payStatus = String(b.payment_status || prev.payment_status || 'pending').toLowerCase();
    if (payStatus === 'unpaid') payStatus = 'pending';
    if (payStatus!=='pending') return res.status(400).json({success:false,error:'Payment status is derived from the payment ledger'});
    const status = String(b.status || prev.status || 'open').toLowerCase();
    const balanceDue = payStatus === 'paid' ? 0 : total;

    const { rows } = await pool.query(
      `UPDATE invoices SET
         invoice_type = $2, subtotal = $3, vat_rate = $4, vat_amount = $5,
         total_amount = $6, balance_due = $7, amount_paid = $8, payment_status = $9,
         status = $10, issue_date = $11, due_date = $12, line_items = $13, updated_at = NOW()
       WHERE invoice_id = $1 AND COALESCE(amount_paid,0)=0
         AND NOT EXISTS(SELECT 1 FROM payments WHERE invoice_id=$1 AND status='successful') RETURNING *`,
      [req.params.id, b.invoice_type || prev.invoice_type, subtotal, vatRate, vatAmount,
       total, balanceDue, total - balanceDue, payStatus, status,
       b.issue_date || prev.issue_date, b.due_date || prev.due_date, JSON.stringify(items)]);

    if (!rows.length) return res.status(409).json({success:false,error:'Invoice changed during editing; refresh before saving'});
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
    if (isClient(req) && String(rows[0].user_id) !== String(req.billingOwnerId)) {
      return res.status(403).json({ success: false, error: 'Not authorised' });
    }
    const payments=await pool.query('SELECT payment_id,amount,currency,payment_method,transaction_reference,status,payment_date,created_at FROM payments WHERE invoice_id=$1 ORDER BY payment_date DESC',[req.params.id]);
    rows[0].payments=payments.rows;
    const successful=payments.rows.filter(p=>p.status==='successful');
    const currencyMismatch=!/^[A-Z]{3}$/.test(String(rows[0].currency || '')) || successful.some(p=>p.currency!==rows[0].currency);
    rows[0].paid_total=currencyMismatch ? null : successful.reduce((sum,p)=>sum+Number(p.amount),0);
    rows[0].reconciliation_required=currencyMismatch || Math.abs(Number(rows[0].amount_paid ?? 0)-rows[0].paid_total)>0.01;
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
           ) AS sensor_ids,
           (SELECT COALESCE(json_agg(json_build_object(
                     'payment_id', pay.payment_id, 'amount', pay.amount, 'currency', pay.currency,
                     'payment_method', pay.payment_method, 'transaction_reference', pay.transaction_reference,
                     'status', pay.status, 'payment_date', pay.payment_date, 'created_at', pay.created_at)
                     ORDER BY COALESCE(pay.payment_date, pay.created_at) DESC), '[]'::json)
              FROM payments pay WHERE pay.invoice_id = i.invoice_id) AS payments,
           (SELECT COALESCE(SUM(pay.amount), 0) FROM payments pay
             WHERE pay.invoice_id = i.invoice_id AND pay.status = 'successful') AS paid_total
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

    if (inv.currency!=='NGN') NG=/^[A-Z]{3}$/.test(String(inv.currency || '')) ? inv.currency+' ' : 'Currency unknown ';
    const money = n => n==null || n==='' || !Number.isFinite(Number(n)) ? 'Not supplied' : NG + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
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
    let my = 115;
    [['Invoice No.', inv.invoice_id], ['Issue date', fmtDate(inv.issue_date || inv.created_at)], ['Due date', fmtDate(inv.due_date)]].forEach(([k, v]) => {
      doc.font(F.r).fontSize(9).fillColor(GREY).text(k, R - 245, my, { width: 95, align: 'right' });
      doc.font(F.b).fontSize(9).fillColor(BLACK);
      const value=String(v || '—');
      const valueHeight=doc.heightOfString(value,{width:140});
      doc.text(value, R - 140, my, { width: 140, align: 'right' });
      my += Math.max(15,valueHeight+5);
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
    const hy = Math.max(150,my+32);
    doc.moveTo(L, hy).lineTo(R, hy).lineWidth(1).strokeColor(BLACK).stroke();
    doc.moveTo(L, hy).lineTo(L + 90, hy).lineWidth(2.5).strokeColor(GREEN).stroke();

    const sectionLabel = (t, x, yy) => doc.font(F.b).fontSize(8.5).fillColor(GREEN).text(t.toUpperCase(), x, yy, { characterSpacing: 0.6 });

    // ── BILL TO ──
    sectionLabel('Bill to', L, hy+20);
    doc.font(F.b).fontSize(11).fillColor(BLACK).text(inv.property_name || '—', L, hy+36, { width: 245 });
    const addr = [inv.address_line1, [inv.city, inv.state].filter(Boolean).join(', '), 'Nigeria'].filter(Boolean).join('\n');
    doc.font(F.r).fontSize(9).fillColor(GREY).text(addr || '—', L, doc.y + 2, { width: 245 });
    if (!inv.client_name)
      doc.font(F.r).fontSize(8.5).fillColor(LGREY).text('No billing contact is linked to this property yet — invoice issued against the property record only.', L, doc.y + 5, { width: 245 });
    else
      doc.font(F.r).fontSize(9).fillColor(GREY).text(inv.client_name + (inv.client_email ? '  ·  ' + inv.client_email : ''), L, doc.y + 4, { width: 245 });

    // ── INVOICE DETAILS ──
    const billBottom=doc.y;
    sectionLabel('Invoice details', 315, hy+20);
    let dy = hy+38;
    const sensors = Array.isArray(inv.sensor_ids) ? inv.sensor_ids : [];
    [['Invoice type', cap(inv.invoice_type)], ['Property ref', inv.property_ref], ['Sentinel coverage', sensors.length ? sensors.join(', ') : 'None']].forEach(([k, v]) => {
      doc.font(F.r).fontSize(9).fillColor(GREY).text(k, 315, dy, { width: 95 });
      const h = doc.heightOfString(String(v || '—'), { width: 140 });
      doc.font(F.b).fontSize(9).fillColor(BLACK).text(String(v || '—'), 412, dy, { width: 138 });
      dy += Math.max(16, h + 5);
    });

    // ── line items table ──
    const items = Array.isArray(inv.line_items) ? inv.line_items : (() => { try { return JSON.parse(inv.line_items || '[]'); } catch { return []; } })();
    let ty = Math.max(hy+125, dy + 14, billBottom + 14);
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
      if (ry+rh>doc.page.height-150) {doc.addPage();ry=45;}
      doc.text(String(it.description || '—'), L + 8, ry + 7, { width: 250 });
      doc.fillColor(BLACK).text(it.qty != null ? String(it.qty) : '—', 305, ry + 7, { width: 50, align: 'right' });
      doc.text(it.unit_price != null ? money(it.unit_price) : '—', 365, ry + 7, { width: 90, align: 'right' });
      doc.font(F.b).text(money(it.amount), 465, ry + 7, { width: 77, align: 'right' });
      ry += rh;
      doc.moveTo(L, ry).lineTo(R, ry).lineWidth(0.5).strokeColor(LINE).stroke();
    });

    // ── totals ──
    let tvy = ry + 14;
    if (tvy+150>doc.page.height-60) {doc.addPage();tvy=45;}
    const balance = inv.balance_due != null ? Number(inv.balance_due) : null;
    const totRow = (label, val, bold) => {
      doc.font(bold ? F.b : F.r).fontSize(9.5).fillColor(bold ? BLACK : GREY).text(label, 320, tvy, { width: 130, align: 'right' });
      doc.font(bold ? F.b : F.r).fillColor(BLACK).text(val, 460, tvy, { width: 82, align: 'right' });
      tvy += 17;
    };
    totRow('Subtotal', money(inv.subtotal != null ? inv.subtotal : inv.total_amount));
    if (Number(inv.vat_amount) > 0 || inv.vat_rate != null) totRow(`VAT (${inv.vat_rate != null ? inv.vat_rate : 'unknown'}%)`, money(inv.vat_amount));
    totRow('Total', money(inv.total_amount), true);
    if (Number(inv.amount_paid) > 0) totRow('Amount paid', money(inv.amount_paid));
    // balance-due highlight box
    const bcol = balance==null ? BLACK : balance > 0 ? RED : GREEN;
    doc.rect(320, tvy + 2, 222, 26).fill(balance==null ? '#eeeeee' : balance > 0 ? RED_T : GREEN_T);
    doc.fillColor(bcol).font(F.b).fontSize(10).text('BALANCE DUE', 328, tvy + 10, { width: 120 });
    doc.text(money(balance), 440, tvy + 10, { width: 96, align: 'right' });
    tvy += 40;

    // ── footer notes ──
    let fy = Math.max(tvy + 16, 690);
    doc.font(F.r).fontSize(8.5).fillColor(GREY).text('For the payment due date, refer to the invoice record. For payment queries or to confirm receipt, contact support@flowguard.ng or call 020 1700 3062.', L, fy, { width: W });
    if (ps === 'partial') doc.text('This invoice reflects a partial payment already received against the total above. A full itemized payment history is available on request.', L, doc.y + 6, { width: W });
    doc.font(F.r).fontSize(8).fillColor(LGREY).text('FlowGuard Solutions Limited  ·  Lagos, Nigeria  ·  support@flowguard.ng  ·  @theflowguards', L, doc.page.height-60, { width: W, align: 'center', lineBreak:false });

    doc.end();
  });
}

// GET /billing/invoices/:id/pdf — download the invoice PDF.
router.get('/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const inv = await fetchInvoiceFull(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (isClient(req) && String(inv.user_id) !== String(req.billingOwnerId)) return res.status(403).json({ success: false, error: 'Not authorised' });
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
    const deliveryKey=req.body?.request_id||randomUUID();
    if(typeof deliveryKey!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryKey))return res.status(400).json({success:false,error:'Valid email request id required'});
    const inv = await fetchInvoiceFull(req.params.id);
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (!inv.client_email) return res.status(400).json({ success: false, error: 'No client email on file — link a client to this property first.' });
    const pdf = await renderInvoicePdf(inv).catch(() => null);
    const delivery = await require('../utils/mailer').sendInvoice(
      inv.client_email, inv.client_name,
      { invoiceId: inv.invoice_id, propertyName: inv.property_name, total: inv.total_amount, balanceDue: inv.balance_due, dueDate: inv.due_date, currency: '₦',deliveryKey,userId:inv.user_id },
      pdf);
    if(!delivery.accepted){
      return res.status(delivery.queued?202:503).json({success:!!delivery.queued,data:{emailed:false,queued:!!delivery.queued,delivery_ids:delivery.ids||[]},...(!delivery.queued?{error:'Invoice email was not accepted; invoice was not marked sent'}:{})});
    }
    const emailed=true;
    if(!delivery.durable){
    await pool.query(
      `UPDATE invoices SET sent_at = NOW(), sent_count = COALESCE(sent_count,0)+1,
         status = CASE WHEN status IN ('draft','open') THEN 'sent' ELSE status END, updated_at = NOW()
       WHERE invoice_id = $1 RETURNING sent_at, sent_count`, [req.params.id]);
    }
    const {rows}=await pool.query('SELECT sent_at,sent_count FROM invoices WHERE invoice_id=$1',[req.params.id]);
    logAction(req.user.id, 'sent an invoice to the client', 'invoice', req.params.id, { to: inv.client_email });
    if (inv.user_id) require('../utils/notify').notify(inv.user_id, {
      type: 'invoice', title: 'New invoice ' + inv.invoice_id, message: 'A new invoice is ready to view and pay.', link: '#billing',
    });
    res.json({ success: true, data: { emailed, to: inv.client_email, sent_at: rows[0].sent_at, sent_count: rows[0].sent_count } });
  } catch (err) {
    console.error('POST /billing/invoices/:id/send', err);
    res.status(500).json({ success: false, error: 'Failed to send invoice' });
  }
});

// POST /billing/invoices/:id/mark-paid — this waives a real balance; restrict
// to roles that actually handle money.
router.post('/invoices/:id/mark-paid', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  return res.status(409).json({success:false,error:'Record a payment through the ledger; invoice status alone is not evidence of collection'});
  /* Legacy shortcut retained for migration context, never executed.
  try {
    const { rows } = await pool.query(
      `UPDATE invoices SET payment_status='paid', status='paid', paid_date=CURRENT_DATE,
         amount_paid=total_amount, balance_due=0, updated_at=NOW()
       WHERE invoice_id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success:false, error:'Invoice not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success:false, error:'Failed to mark paid' }); }
  */
});

// POST /billing/invoices/:id/payments — record a real payment against the
// `payments` ledger, then recompute the invoice snapshot from the ledger.
// Supports partial payments: balance_due and payment_status are derived from
// SUM(successful payments), never guessed. Restricted to money-handling roles.
router.post('/invoices/:id/payments', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = (await client.query(
      'SELECT invoice_id, user_id, total_amount,amount_paid,currency FROM invoices WHERE invoice_id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!inv) {await client.query('ROLLBACK');return res.status(404).json({ success: false, error: 'Invoice not found' }); }
    if (!/^[A-Z]{3}$/.test(String(inv.currency || '')) || (req.body.currency && req.body.currency!==inv.currency)) {await client.query('ROLLBACK');return res.status(409).json({success:false,error:'Payment currency must match a known invoice currency'});}
    const currencyMismatch=await client.query("SELECT COUNT(*)::int n FROM payments WHERE invoice_id=$1 AND status='successful' AND currency IS DISTINCT FROM $2",[inv.invoice_id,inv.currency]);
    if (currencyMismatch.rows[0].n>0) {await client.query('ROLLBACK');return res.status(409).json({success:false,error:'Mixed-currency ledger requires reconciliation'});}

    const amount = Number(req.body && req.body.amount);
    if (!Number.isFinite(amount) || !(amount > 0) || typeof req.body.amount==='boolean') {await client.query('ROLLBACK');return res.status(400).json({ success: false, error: 'A positive finite amount is required' }); }
    const method = String((req.body && req.body.payment_method) || '').trim() || 'bank_transfer';
    const ref = String((req.body && req.body.transaction_reference) || '').trim() || null;
    const when = (req.body && req.body.payment_date) ? new Date(req.body.payment_date) : new Date();
    if (!Number.isFinite(when.getTime()) || when.getTime()>Date.now()) {await client.query('ROLLBACK');return res.status(400).json({ success: false, error: 'Valid non-future payment date required' }); }
    const recorded=Number((await client.query("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=$1 AND status='successful'",[inv.invoice_id])).rows[0].s);
    if (!Number.isFinite(Number(inv.total_amount)) || inv.total_amount==null || Math.abs(Number(inv.amount_paid ?? 0)-recorded)>0.01) {await client.query('ROLLBACK');return res.status(409).json({success:false,error:'Invoice requires ledger reconciliation before recording another payment'});}
    if (amount>Number(inv.total_amount)-recorded+0.001) {await client.query('ROLLBACK');return res.status(409).json({success:false,error:'Payment exceeds the recorded remaining balance'});}
    if (ref && (await client.query("SELECT payment_id FROM payments WHERE invoice_id=$1 AND transaction_reference=$2 AND status='successful'",[inv.invoice_id,ref])).rows.length) {await client.query('ROLLBACK');return res.status(409).json({success:false,error:'Payment reference is already recorded for this invoice'});}
    const payId = 'PAY-' + randomUUID();
    await client.query(
      `INSERT INTO payments (payment_id, invoice_id, user_id, amount, currency, payment_method, transaction_reference, status, payment_date)
       VALUES ($1,$2,$3,$4,$8,$5,$6,'successful',$7)`,
      [payId, inv.invoice_id, inv.user_id, amount, method, ref, when,inv.currency]);

    const paid = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=$1 AND status='successful'`,
      [inv.invoice_id])).rows[0].s);
    const total = Number(inv.total_amount) || 0;
    const bal = Math.max(0, +(total - paid).toFixed(2));
    const pstatus = bal <= 0 ? 'paid' : (paid > 0 ? 'partial' : 'pending');
    await client.query(
      `UPDATE invoices SET amount_paid=$1, balance_due=$2, payment_status=$3,
         status=CASE WHEN $3='paid' THEN 'paid' ELSE status END,
         paid_date=CASE WHEN $3='paid' THEN $5::timestamptz::date ELSE paid_date END,
         updated_at=NOW() WHERE invoice_id=$4`,
      [paid, bal, pstatus, inv.invoice_id,when]);
    await client.query('COMMIT');

    logAction(req.user.id, 'recorded a payment', 'invoice', inv.invoice_id, { payment_id: payId, amount, method });
    res.json({ success: true, data: { payment_id: payId, paid_total: paid, balance_due: bal, payment_status: pstatus } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /billing/invoices/:id/payments', err);
    res.status(500).json({ success: false, error: 'Failed to record payment' });
  } finally {
    client.release();
  }
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
    if (isClient(req) && String(inv.user_id) !== String(req.billingOwnerId)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const note = String((req.body && req.body.note) || '').slice(0, 1000);
    const ticketId = 'TKT-' + Date.now() + '-' + Math.floor(Math.random() * 900 + 100);
    const desc = `Client reports payment for ${inv.invoice_id} (balance ₦${Number(inv.balance_due || 0).toLocaleString()}). Finance to confirm receipt and mark the invoice paid.${note ? ' Client note: ' + note : ''}`;
    await pool.query(
      `INSERT INTO tickets (ticket_id, title, description, priority, category, property_id, user_id, status, created_by)
       VALUES ($1,$2,$3,'high','billing',$4,$5,'new',$6)`,
      [ticketId, 'Payment notification — ' + inv.invoice_id, desc, inv.property_id, inv.user_id, req.user.email]);
    logAction(req.user.id, 'notified a payment', 'invoice', inv.invoice_id, { ticket_id: ticketId });
    // Surface it in the ops notification center for finance/ops to reconcile.
    require('../utils/notify').notifyInternal(
      { type: 'billing', title: 'Payment reported', message: 'A client reported payment for ' + inv.invoice_id + ' — finance to confirm receipt.', link: '#support/' + ticketId },
      { roles: ['finance', 'operations_manager', 'admin', 'super_admin'] });
    res.status(201).json({ success: true, data: { ticket_id: ticketId } });
  } catch (err) {
    console.error('POST /billing/invoices/:id/notify-payment', err);
    res.status(500).json({ success: false, error: 'Failed to send payment notification' });
  }
});

// POST /billing/invoices/:id/send-reminder
router.post('/invoices/:id/send-reminder', authenticateToken, requirePermission('billing.manage'), async (req, res) => {
  if(process.env.LIFECYCLE_EMAILS_ENABLED!=='true'||process.env.MAIL_OUTBOX_ENABLED!=='true'||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||/@resend\.dev\b/i.test(process.env.MAIL_FROM))return res.status(503).json({success:false,error:'Reminder delivery is not enabled; no reminder was sent'});
  const requestId=req.body?.request_id||randomUUID();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))return res.status(400).json({success:false,error:'Invalid request_id'});
  let db;
  try{
    db=await pool.connect();
    await db.query('BEGIN');
    const inv=(await db.query('SELECT * FROM invoices WHERE invoice_id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!inv||!(Number(inv.balance_due)>0)){await db.query('ROLLBACK');return res.status(inv?409:404).json({success:false,error:inv?'Invoice has no outstanding balance':'Invoice not found'});}
    if(!await require('../utils/invoiceReminder').eligible(db,inv)){await db.query('ROLLBACK');return res.status(409).json({success:false,error:'Reminder requires an issued invoice, active client owner and reconciled payment ledger'});}
    await require('../utils/emailSchedules').createSchedules({pool}).record(db,'invoices',inv.invoice_id,'invoice_reminder',requestId);
    await db.query('COMMIT');
    return res.status(202).json({success:true,data:{queued:true,sent:false,request_id:requestId}});
  }catch(_){if(db)await db.query('ROLLBACK').catch(()=>{});return res.status(503).json({success:false,error:'Reminder could not be queued'});}finally{db?.release();}
});

// GET /billing/:propertyId — per-property billing (CLIENT PORTAL)
// Returns { subscription, sla, payment_history } shape
router.get('/:propertyId', authenticateToken, async (req, res) => {
  try {
    const pid = req.params.propertyId;
    const prop = await pool.query('SELECT * FROM properties WHERE property_id = $1', [pid]);
    if (!prop.rows[0]) return res.status(404).json({ success: false, error: 'Property not found' });
    const property = prop.rows[0];
    if (isClient(req) && String(property.user_id) !== String(req.billingOwnerId)) {
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
      amount: monthly != null && Number.isFinite(monthly) ? monthly : null,
      currency: 'NGN',
      billing_cycle: 'monthly',
      next_billing_date: null,
      started_at: property.deployed_at || property.created_at,
    };

    const sla = {
      uptime_guarantee: null,
      current_uptime: null,
      response_time_hours: null,
      avg_response_hours: null,
      incidents_resolved: null,
      incidents_total: null,
      basis: 'Contractual targets and measured SLA performance are not supplied by this billing feed.',
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
