// utils/briefing.js — turns a (already-computed) horizon forecast into a
// plain-language operational briefing via the LLM layer, with a deterministic
// template fallback when no LLM key is set or the provider errors.
//
// Shared by the ops route (/ai/brief, full portfolio) and the client route
// (/client-forecast/brief, scoped to the client's own estates). Callers pass
// the forecast object so client isolation is enforced upstream: a single-estate
// brief looks the estate up INSIDE the forecast it was given, so a client can
// only ever brief an estate that survived their scoping filter.
const { askLLM } = require('./llm');

const SYSTEM = [
  "You are FlowGuard's flood-risk analyst writing a briefing for the operator of a drainage estate in Lagos.",
  'CRITICAL RULES:',
  '- Use ONLY the numbers, names, times and drivers present in the JSON provided. Never invent, round differently, or estimate any figure.',
  '- If a value is null or missing, say it is unavailable — do not guess.',
  '- Risk is on a 0–100 scale. "horizons" are the projected risk now / +1h / +3h / +6h.',
  '- Be concise, concrete and action-oriented. No marketing language, no emojis.',
  '- Lead with the risk level and the single most important action.',
].join('\n');

function riskLevel(v) {
  return v >= 80 ? 'CRITICAL' : v >= 60 ? 'HIGH' : v >= 35 ? 'MODERATE' : 'LOW';
}

function templateBrief(est) {
  if (!est) return 'No estate data available.';
  const h = est.horizons || {};
  const drivers = (est.drivers || []).slice(0, 3).map(d => d.label).join('; ') || 'no dominant driver';
  const cw = est.critical_window ? ` Critical risk likely around ${est.critical_window.label}.` : '';
  const anom = est.anomaly ? ` ${est.anomaly.note}` : '';
  return `${est.name}: ${riskLevel(est.current_risk)} risk (${est.current_risk}/100). Projected ${h.h1}/${h.h3}/${h.h6} at +1h/+3h/+6h.${cw}${anom} Main drivers: ${drivers}. Recommended action: ${est.recommendation}. Confidence ${est.confidence}%.`;
}

function templatePortfolio(p, estates) {
  const lines = [
    `${p.total} estate${p.total === 1 ? '' : 's'} monitored. ${p.critical_now} critical now, ${p.entering_high_3h} entering high risk within 3h, ${p.preventive_recommended} due preventive maintenance, ${p.anomalies} anomalies flagged.`,
  ];
  estates.slice(0, 5).forEach(e => lines.push(`• ${e.name} — ${e.current_risk}→${e.horizons.h3} (3h): ${e.recommendation}`));
  return lines.join('\n');
}

// generateBrief({ forecast, property_id?, scope? })
//  -> { ai:true, provider, model, briefing, structured }
//   | { ai:false, reason, status, detail, briefing, structured }
//   | { notFound:true }   (property_id given but not in this (scoped) forecast)
async function generateBrief({ forecast, property_id, scope }) {
  const wantPortfolio = scope === 'portfolio' || !property_id;

  let structured, fallback, userPrompt, maxTokens;
  if (wantPortfolio) {
    const top = forecast.estates.slice(0, 8);
    structured = {
      portfolio: forecast.portfolio, rain_next_3h_mm: forecast.rain_next_3h_mm,
      generated_at: forecast.generated_at, estates: top,
    };
    fallback = templatePortfolio(forecast.portfolio, forecast.estates);
    userPrompt = 'Write a short morning portfolio briefing (3–5 sentences + a prioritised bullet list of the estates needing action today). Data:\n' + JSON.stringify(structured);
    maxTokens = 800;
  } else {
    const est = forecast.estates.find(e => String(e.property_id) === String(property_id));
    if (!est) return { notFound: true };
    structured = est;
    fallback = templateBrief(est);
    userPrompt = 'Write a 2–4 sentence risk briefing for this single estate: the risk level and trajectory, the main drivers, and the recommended action. Data:\n' + JSON.stringify(est);
    maxTokens = 400;
  }

  const ai = await askLLM({ system: SYSTEM, user: userPrompt, maxTokens });
  if (ai.ok) {
    return { ai: true, provider: ai.provider, model: ai.model, briefing: ai.text, structured };
  }
  return { ai: false, reason: ai.reason, status: ai.status || null, detail: ai.detail || null, briefing: fallback, structured };
}

module.exports = { generateBrief, templateBrief, templatePortfolio, SYSTEM };
