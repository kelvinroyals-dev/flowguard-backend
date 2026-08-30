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

const RUN_HOUR_LAGOS = 6;   // 06:00 West Africa Time (UTC+1, no DST)

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
  } catch (err) { console.error('[dailyBrief] ops portfolio failed:', err.message); }

  // 2) Per client account owner, scoped to their own estates.
  let owners = [];
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users
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
