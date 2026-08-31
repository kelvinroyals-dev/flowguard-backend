// utils/dailyBrief.js — morning batch that generates and stores the daily AI
// risk briefing: one ops portfolio briefing, plus one per client account owner
// (scoped to that org's estates). The portals read the latest stored row, so a
// client opening the app at 9am sees the 6am briefing instantly (no LLM wait).
//
// Scheduling mirrors utils/health.js: run once on boot if today's is missing,
// then every day aligned to ~06:00 Africa/Lagos.
const pool = require('../config/database');
const { buildHorizonForecast, scopeHorizonsToProperties } = require('./riskForecast');
const { generateBrief } = require('./briefing');
const { propertyIdsForUser } = require('./scope');
const mailer = require('./mailer');

const RUN_HOUR_LAGOS = 6;   // 06:00 West Africa Time (UTC+1, no DST)

// Email delivery is opt-in via env so we never surprise real inboxes:
//   BRIEF_EMAIL_TO       comma-separated ops recipients for the portfolio brief
//   BRIEF_EMAIL_CLIENTS  'true' to also email each client owner their own brief
const OPS_RECIPIENTS = (process.env.BRIEF_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const EMAIL_CLIENTS = String(process.env.BRIEF_EMAIL_CLIENTS || '').toLowerCase() === 'true';

// Render a stored briefing as a branded HTML email and send it.
async function emailBrief(to, subject, out, portfolio) {
  if (!to || (Array.isArray(to) && !to.length)) return;
  const p = portfolio || {};
  const triage = `${p.total ?? 0} estates · ${p.critical_now ?? 0} critical now · ${p.entering_high_3h ?? 0} entering high (3h) · ${p.anomalies ?? 0} anomalies`;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(out.briefing || '').split('\n').filter(Boolean)
    .map(line => `<p style="margin:0 0 12px;font-size:14px;color:#4a626d;line-height:1.6;">${esc(line)}</p>`).join('');
  const body = `<p style="margin:0 0 14px;font-size:13px;color:#8399a4;">${esc(triage)}</p>${paras}`;
  try { await mailer.sendEmail({ to, subject, html: mailer.shell(subject, body) }); }
  catch (e) { console.error('[dailyBrief] email failed:', e.message); }
}

async function persist({ scope, ownerId, out, portfolio }) {
  await pool.query(
    `INSERT INTO daily_briefings (scope, owner_id, ai, provider, model, briefing, portfolio, structured)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [scope, ownerId || null, !!out.ai, out.provider || null, out.model || null,
     out.briefing || '', portfolio ? JSON.stringify(portfolio) : null,
     out.structured ? JSON.stringify(out.structured) : null]);
}

// Generate + store all briefings for one run. Reuses a SINGLE horizon forecast
// (one Open-Meteo call, one DB scan) and scopes it per client.
async function runOnce() {
  const startedAt = Date.now();
  let forecast;
  try { forecast = await buildHorizonForecast(); }
  catch (err) { console.error('[dailyBrief] forecast failed:', err.message); return; }

  // 1) Ops portfolio (all estates).
  try {
    const out = await generateBrief({ forecast, scope: 'portfolio' });
    await persist({ scope: 'ops_portfolio', ownerId: null, out, portfolio: forecast.portfolio });
    if (OPS_RECIPIENTS.length) await emailBrief(OPS_RECIPIENTS, 'FlowGuard — morning risk briefing', out, forecast.portfolio);
  } catch (err) { console.error('[dailyBrief] ops portfolio failed:', err.message); }

  // 2) Per client account owner, scoped to their own estates.
  let owners = [];
  try {
    const { rows } = await pool.query(
      `SELECT id, email, full_name FROM users
        WHERE user_type='client' AND account_owner_id IS NULL AND COALESCE(is_active, true) = true`);
    owners = rows;
  } catch (err) { console.error('[dailyBrief] owner list failed:', err.message); }

  let clientCount = 0;
  for (const o of owners) {
    try {
      const ids = await propertyIdsForUser(o.id);
      if (!ids.length) continue;                       // no estates → nothing to brief
      const scoped = scopeHorizonsToProperties(forecast, ids);
      if (!scoped.estates.length) continue;
      const out = await generateBrief({ forecast: scoped, scope: 'portfolio' });
      await persist({ scope: 'client', ownerId: o.id, out, portfolio: scoped.portfolio });
      if (EMAIL_CLIENTS && o.email) await emailBrief(o.email, 'Your FlowGuard morning risk briefing', out, scoped.portfolio);
      clientCount++;
    } catch (err) { console.error(`[dailyBrief] client ${o.id} failed:`, err.message); }
  }
  console.log(`[dailyBrief] done — ops + ${clientCount} client briefings in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

// Milliseconds until the next RUN_HOUR in Africa/Lagos (UTC+1, fixed offset).
function msUntilNextRun() {
  const now = new Date();
  const lagosNowMs = now.getTime() + (now.getTimezoneOffset() + 60) * 60000; // shift to UTC+1
  const lagos = new Date(lagosNowMs);
  const next = new Date(lagos);
  next.setHours(RUN_HOUR_LAGOS, 0, 0, 0);
  if (next <= lagos) next.setDate(next.getDate() + 1);
  return next.getTime() - lagos.getTime();
}

async function hasTodaysOpsBriefing() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM daily_briefings
        WHERE scope='ops_portfolio' AND generated_at > NOW() - INTERVAL '20 hours' LIMIT 1`);
    return rows.length > 0;
  } catch (_) { return false; }
}

function startDailyBriefings() {
  // Fill today's if it's missing (e.g. first deploy, or a restart before 6am).
  hasTodaysOpsBriefing().then(has => { if (!has) runOnce(); });
  // Align to the next 06:00 Lagos, then repeat every 24h.
  const delay = msUntilNextRun();
  setTimeout(function tick() {
    runOnce();
    setInterval(runOnce, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`[dailyBrief] next run in ${(delay / 3600000).toFixed(1)}h`);
}

module.exports = { runOnce, startDailyBriefings };
