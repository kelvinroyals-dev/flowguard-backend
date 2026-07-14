// utils/reportPdf.js — generate a branded inspection-report PDF with pdfkit.
// Returns a Buffer (so the route can stream it without writing to disk).

const PDFDocument = require('pdfkit');

const BRAND = '#0891b2';
const BRAND_DEEP = '#0e5b6e';
const INK = '#12222b';
const INK2 = '#4a626d';
const INK3 = '#8399a4';
const LINE = '#e2e9ed';

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return String(d); }
}

function asList(v) {
  if (!v) return [];
  let val = v;
  if (typeof val === 'string') { try { val = JSON.parse(val); } catch (_) { return [String(v)]; } }
  if (Array.isArray(val)) return val.map(x => typeof x === 'string' ? x : (x.text || x.item || JSON.stringify(x)));
  if (typeof val === 'object') return Object.values(val).map(String);
  return [String(val)];
}

/**
 * report: row from inspection_reports (+ joined property/inspection fields)
 * Returns Promise<Buffer>
 */
function generateReportPdf(report) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width;
      const left = 50, right = pageW - 50, contentW = right - left;

      // ── Header band ──
      doc.rect(0, 0, pageW, 90).fill(BRAND_DEEP);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('FlowGuard', left, 30);
      doc.font('Helvetica').fontSize(9).fillColor('#cdeef4')
         .text('DRAINAGE-AS-A-SERVICE', left, 58, { characterSpacing: 2 });
      doc.font('Helvetica').fontSize(9).fillColor('#cdeef4')
         .text('Inspection Report', left, 30, { width: contentW, align: 'right' });
      doc.fontSize(9).fillColor('#ffffff')
         .text(report.report_id || '', left, 44, { width: contentW, align: 'right' });

      let y = 120;

      // ── Title + property ──
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18)
         .text(report.property_name || 'Property inspection', left, y);
      y = doc.y + 4;
      const loc = [report.city, report.state].filter(Boolean).join(', ');
      doc.fillColor(INK3).font('Helvetica').fontSize(10)
         .text([loc, report.property_id].filter(Boolean).join('  ·  '), left, y);
      y = doc.y + 16;

      // ── Meta row (date, status, inspector) ──
      doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
      y += 12;
      const meta = [
        ['Report date', fmtDate(report.sent_to_client_at || report.created_at)],
        ['Status', (report.status || 'sent').replace(/_/g, ' ')],
        ['Inspector / team', report.submitted_by_name || report.team_name || '—'],
      ];
      const colW = contentW / meta.length;
      meta.forEach((m, i) => {
        const x = left + i * colW;
        doc.fillColor(INK3).font('Helvetica').fontSize(8).text(m[0].toUpperCase(), x, y, { characterSpacing: 1 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(m[1], x, y + 12, { width: colW - 10 });
      });
      y += 44;

      // ── Score + risk callout ──
      const score = report.drainage_condition_score;
      const risk = report.flood_risk_level;
      if (score != null || risk) {
        doc.roundedRect(left, y, contentW, 60, 8).fill('#f7fafb');
        if (score != null) {
          doc.fillColor(INK3).font('Helvetica').fontSize(8).text('DRAINAGE CONDITION', left + 16, y + 12, { characterSpacing: 1 });
          const sc = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
          doc.fillColor(sc).font('Helvetica-Bold').fontSize(24).text(`${score}`, left + 16, y + 24);
          doc.fillColor(INK3).font('Helvetica').fontSize(10).text('/ 100', left + 16 + doc.widthOfString(`${score}`) + 4, y + 36);
        }
        if (risk) {
          doc.fillColor(INK3).font('Helvetica').fontSize(8).text('FLOOD RISK', left + contentW / 2, y + 12, { characterSpacing: 1 });
          const rc = /high|critical/.test(risk) ? '#ef4444' : /mod|med/.test(risk) ? '#f59e0b' : '#10b981';
          doc.fillColor(rc).font('Helvetica-Bold').fontSize(18).text(String(risk).toUpperCase(), left + contentW / 2, y + 26);
        }
        y += 76;
      }

      // ── Section helper ──
      function section(title, body) {
        if (!body || (Array.isArray(body) && !body.length)) return;
        if (y > doc.page.height - 120) { doc.addPage(); y = 60; }
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12).text(title, left, y);
        y = doc.y + 6;
        if (Array.isArray(body)) {
          body.forEach(item => {
            if (y > doc.page.height - 80) { doc.addPage(); y = 60; }
            doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text('•', left, y, { continued: false });
            doc.fillColor(INK2).font('Helvetica').fontSize(10.5).text(item, left + 16, y, { width: contentW - 16, lineGap: 2 });
            y = doc.y + 6;
          });
        } else {
          doc.fillColor(INK2).font('Helvetica').fontSize(10.5).text(body, left, y, { width: contentW, lineGap: 2 });
          y = doc.y + 6;
        }
        y += 10;
      }

      section('Executive summary', report.executive_summary || report.findings);
      section('Detailed findings', asList(report.detailed_findings));
      section('Drainage capacity', report.drainage_capacity_assessment);
      section('Infrastructure condition', report.infrastructure_condition);
      section('Risk assessment', asList(report.risk_assessment));
      section('Recommendations', report.recommendations ? [report.recommendations] : asList(report.recommended_solutions));

      // ── Footer on every page ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fillColor(INK3).font('Helvetica').fontSize(8)
           .text('© 2026 FlowGuard Solutions · Stratum Infrastructure Group', left, doc.page.height - 40, { width: contentW, align: 'left' });
        doc.text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 40, { width: contentW, align: 'right' });
      }

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generateReportPdf };
