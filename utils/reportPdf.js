// utils/reportPdf.js — branded field-report PDF (inspection / maintenance /
// incident) for clients. Matches the FlowGuard report template. Returns a
// Buffer so the route streams it without touching disk.
//
// Only real, captured data is rendered — sections we don't collect yet
// (site photos, per-metric breakdown, a site map) are omitted rather than
// faked. Single A4 page unless findings/recommendations overflow.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ── palette (from the report template) ──────────────────────────────
const GREEN = '#1f9d5b', AMBER = '#e0a913', RED = '#e5483c', TEAL = '#0d9488';
const INK = '#151b22', INK2 = '#5b6670', INK3 = '#98a2ab';
const BORDER = '#e7eaed';

const LOGO = path.join(__dirname, '..', 'assets', 'fg-logo.png');

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return String(d); }
}
function fmtTime(d) {
  if (!d) return null;
  try { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return null; }
}
const cap = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function condition(score) {
  if (score == null) return { word: 'Not scored', color: INK3 };
  if (score >= 80) return { word: 'Good', color: GREEN };
  if (score >= 50) return { word: 'Fair', color: AMBER };
  return { word: 'Poor', color: RED };
}

const TITLES = {
  inspection:  ['SITE INSPECTION REPORT', 'After inspection'],
  incident:    ['INCIDENT RESPONSE REPORT', 'Post-incident summary'],
  maintenance: ['MAINTENANCE REPORT', 'Work completed'],
  general:     ['FIELD REPORT', 'Field operations'],
};

function generateReportPdf(report) {
  return new Promise((resolve, reject) => {
    try {
      const r = report || {};
      const doc = new PDFDocument({ size: 'A4', margins: { top: 36, left: 36, right: 36, bottom: 16 }, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 36, R = doc.page.width - 36, W = R - L;
      const score = r.drainage_condition_score != null ? Math.round(Number(r.drainage_condition_score)) : null;
      const cond = condition(score);
      const [title, subtitle] = TITLES[String(r.report_type || 'inspection').toLowerCase()] || TITLES.inspection;

      // ── helpers ──
      const card = (x, y, w, h) => doc.roundedRect(x, y, w, h, 10).fillAndStroke('#ffffff', BORDER);
      const label = (txt, x, y, color = INK3) =>
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(color).text(String(txt).toUpperCase(), x, y, { characterSpacing: 1 });
      function fact(x, y, l, v, w) {
        label(l, x, y);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(v || '—', x, y + 11, { width: w });
      }
      function donut(cx, cy, rad, pct, color) {
        const t = 11;
        doc.save().lineWidth(t).strokeColor('#edf0f2').circle(cx, cy, rad).stroke();
        if (pct != null && pct > 0) {
          const a0 = -Math.PI / 2, a1 = a0 + (Math.min(pct, 100) / 100) * 2 * Math.PI;
          const sx = cx + rad * Math.cos(a0), sy = cy + rad * Math.sin(a0);
          const ex = cx + rad * Math.cos(a1), ey = cy + rad * Math.sin(a1);
          doc.lineWidth(t).strokeColor(color).path(`M ${sx} ${sy} A ${rad} ${rad} 0 ${pct > 50 ? 1 : 0} 1 ${ex} ${ey}`).stroke();
        }
        doc.restore();
      }

      // ══ HEADER ══
      let lx = L;
      if (fs.existsSync(LOGO)) { const h = 30; doc.image(LOGO, L, 34, { height: h }); lx = L + Math.round(h * 834 / 620) + 10; }
      doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text('FLOWGUARD', lx, 36);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK3).text('S O L U T I O N S', lx + 1, 54, { characterSpacing: 1 });
      // right-aligned label + value on one line, single string (align:'right' +
      // continued overlaps in pdfkit; lineBreak:false stops any auto-pagination).
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
        .text('Report ID:  ' + (r.report_id || '—'), R - 280, 36, { width: 280, align: 'right', lineBreak: false })
        .text('Date Generated:  ' + fmtDate(r.created_at), R - 280, 50, { width: 280, align: 'right', lineBreak: false });

      // ══ TITLE (left) + SUMMARY CARD (right) ══
      const cardX = L + W * 0.56, cardW = R - cardX, cardY = 92, cardH = 176;
      card(cardX, cardY, cardW, cardH);

      doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(title, L, 104, { width: W * 0.52 - 6 });
      const subY = doc.y + 2;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL).text(subtitle.toUpperCase(), L, subY, { characterSpacing: 1.5 });
      const plY = doc.y + 9;
      doc.save().lineWidth(2.4).strokeColor(INK).moveTo(L, plY).lineTo(L + 150, plY).stroke();
      [TEAL, TEAL, RED].forEach((c, i) => doc.lineWidth(2.4).strokeColor(c).moveTo(L + 40 + i * 45, plY - 4).lineTo(L + 40 + i * 45, plY + 4).stroke());
      doc.restore();
      doc.font('Helvetica').fontSize(9.5).fillColor(INK2).text(
        'This report summarises the drainage assessment carried out at the property listed below.',
        L, plY + 14, { width: W * 0.52 - 6, lineGap: 2 });

      // summary card
      label('Inspection Summary', cardX + 16, cardY + 14, INK2);
      const dcx = cardX + 52, dcy = cardY + 76;
      donut(dcx, dcy, 32, score, cond.color);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(score != null ? `${score}%` : '—', dcx - 32, dcy - 10, { width: 64, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(6).fillColor(INK3).text('HEALTH SCORE', dcx - 32, dcy + 8, { width: 64, align: 'center', characterSpacing: 0.5 });
      label('Overall Condition', cardX + 100, cardY + 44, INK3);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(cond.color).text(cond.word, cardX + 100, cardY + 56);
      const desc = (r.summary || r.executive_summary || 'Assessment completed. See findings and recommendations below.').slice(0, 140);
      doc.font('Helvetica').fontSize(8).fillColor(INK2).text(desc, cardX + 100, cardY + 78, { width: cardW - 116, lineGap: 1.5 });
      const lgY = cardY + cardH - 22;
      [['Good 80–100', GREEN], ['Fair 50–79', AMBER], ['Poor 0–49', RED]].forEach((g, i) => {
        const gx = cardX + 16 + i * ((cardW - 24) / 3);
        doc.circle(gx + 3, lgY + 4, 3).fill(g[1]);
        doc.font('Helvetica').fontSize(6.8).fillColor(INK2).text(g[0], gx + 10, lgY + 1);
      });

      // ══ PROPERTY INFORMATION + INSPECTION DETAILS ══
      let y = 286;
      const colW = W / 2 - 8;
      label('Property Information', L, y, INK); label('Inspection Details', L + colW + 16, y, INK);
      doc.moveTo(L, y + 12).lineTo(L + colW, y + 12).lineWidth(0.7).strokeColor(BORDER).stroke();
      doc.moveTo(L + colW + 16, y + 12).lineTo(R, y + 12).strokeColor(BORDER).stroke();
      y += 22;

      const addr = [r.address_line1, r.city, r.state].filter(Boolean).join(', ');
      const inspDate = r.scheduled_date || r.created_at;
      const propRows = [
        ['Property Name', r.property_name],
        ['Address', addr],
        ['Property Type', r.property_type ? cap(r.property_type) : null],
        ['Estate Size', r.total_area_sqm ? `${Number(r.total_area_sqm).toLocaleString()} sqm` : null],
      ];
      const detRows = [
        ['Report Date', fmtDate(inspDate)],
        ['Time', fmtTime(inspDate)],
        ['Inspector', r.submitted_by_name],
        ['Team', r.team_name],
        ['Report Type', cap(r.report_type || 'inspection')],
      ];
      let yl = y, yr = y;
      propRows.forEach(row => { fact(L, yl, row[0], row[1], colW); yl += 30; });
      detRows.forEach(row => { fact(L + colW + 16, yr, row[0], row[1], colW); yr += 25; });
      y = Math.max(yl, yr) + 2;

      // ══ CONDITION STRIP (real metrics only) ══
      const riskColor = r.flood_risk_level && /high|critical/i.test(r.flood_risk_level) ? RED
        : r.flood_risk_level && /mod|medium/i.test(r.flood_risk_level) ? AMBER : GREEN;
      const metrics = [
        ['Drainage Health', score != null ? `${score}%` : '—', cond.color],
        ['Overall Condition', cond.word, cond.color],
        ['Flood Risk', r.flood_risk_level ? cap(r.flood_risk_level) : '—', riskColor],
        ['Time on Site', r.work_duration_min ? `${r.work_duration_min} min` : '—', INK],
      ];
      label('Drainage System Condition', L, y, INK); y += 15;
      const mW = (W - 3 * 10) / 4, mH = 46;
      metrics.forEach((m, i) => {
        const mx = L + i * (mW + 10);
        card(mx, y, mW, mH);
        label(m[0], mx + 10, y + 8);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(m[2]).text(m[1], mx + 10, y + 22, { width: mW - 16 });
      });
      y += mH + 10;

      // ══ FINDINGS / RECOMMENDATIONS / MATERIALS ══
      function textBlock(heading, body, accent) {
        if (!body || !String(body).trim()) return;
        if (y > doc.page.height - 130) { doc.addPage(); y = 40; }
        label(heading, L, y, INK); y += 13;
        const items = String(body).split(/\r?\n|(?:^|\s)[•\-]\s+/).map(s => s.trim()).filter(Boolean);
        const boxTop = y;
        let ty = y + 9;
        items.forEach(it => {
          if (ty > doc.page.height - 50) { doc.addPage(); ty = 40; }
          doc.circle(L + 13, ty + 4.5, 2).fill(accent);
          doc.font('Helvetica').fontSize(9).fillColor(INK2).text(it, L + 22, ty, { width: W - 38, lineGap: 1.5 });
          ty = doc.y + 5;
        });
        const boxH = ty - boxTop + 4;
        doc.roundedRect(L, boxTop, W, boxH, 10).lineWidth(0.8).strokeColor(BORDER).stroke();
        y = boxTop + boxH + 12;
      }
      textBlock('Findings', r.findings, TEAL);
      textBlock('Recommendations', r.recommendations, GREEN);
      if (r.materials_used && String(r.materials_used).trim()) {
        if (y > doc.page.height - 90) { doc.addPage(); y = 40; }
        label('Materials Used', L, y);
        doc.font('Helvetica').fontSize(9).fillColor(INK2).text(String(r.materials_used), L + 96, y - 1, { width: W - 96, lineBreak: false });
        y += 18;
      }

      // ══ SUMMARY + NEXT VISIT ══
      const summary = r.executive_summary || r.summary;
      if (summary && String(summary).trim()) {
        if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
        label('Summary', L, y, INK); y += 13;
        doc.font('Helvetica').fontSize(9).fillColor(INK2).text(String(summary), L, y, { width: r.due_date ? W * 0.62 : W, lineGap: 2 });
        if (r.due_date) {
          card(L + W * 0.66, y - 4, W * 0.34, 62);
          label('Next Scheduled Visit', L + W * 0.66 + 14, y + 8);
          doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(fmtDate(r.due_date), L + W * 0.66 + 14, y + 24);
        }
        y = doc.y + 10;
      }

      // ══ SIGNATURES / STATUS / CONTACT ══
      // The compact block needs ~52pt; only bump to a new page if that won't fit.
      if (y > doc.page.height - 56) { doc.addPage(); y = 40; }
      const footY = Math.max(y, doc.page.height - 96);
      doc.moveTo(L, footY).lineTo(R, footY).lineWidth(0.8).strokeColor(BORDER).stroke();
      const sy = footY + 12;
      label('Inspector', L, sy);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(r.submitted_by_name || '—', L, sy + 12);
      doc.font('Helvetica').fontSize(8).fillColor(INK3).text('Field Operations', L, sy + 26);
      label('Report Status', L + W * 0.33, sy);
      const st = cap(r.status === 'review' ? 'under review' : r.status || 'submitted');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(/approv|sent/i.test(r.status || '') ? GREEN : INK).text(st, L + W * 0.33, sy + 12);
      label('Need Assistance?', L + W * 0.63, sy);
      doc.font('Helvetica').fontSize(8.5).fillColor(INK2)
        .text('info@flowguard.ng', L + W * 0.63, sy + 12)
        .text('app.flowguard.ng', L + W * 0.63, sy + 24);

      // ══ page footer (single pass; lineBreak:false so it never auto-paginates) ══
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const fy = doc.page.height - 30;
        doc.font('Helvetica').fontSize(7).fillColor(INK3)
          .text('© 2026 FlowGuard Solutions · Confidential', L, fy, { width: W / 2, align: 'left', lineBreak: false });
        doc.text(`Page ${i + 1} of ${range.count}`, L + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
      }

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generateReportPdf };
