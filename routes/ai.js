// routes/ai.js — the LLM briefing layer over FlowGuard's risk engine.
// It runs the (rule-based) horizon forecast, then asks Claude to phrase the
// real numbers as an operational briefing. If no ANTHROPIC_API_KEY is set it
// returns a deterministic template so the feature works without the key.
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { buildHorizonForecast } = require('../utils/riskForecast');
const { askLLM, hasKey, MODEL, PROVIDER } = require('../utils/llm');

const router = express.Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

const SYSTEM = [
  'You are FlowGuard\'s flood-risk analyst writing a briefing for an operations manager in Lagos.',
  'CRITICAL RULES:',
  '- Use ONLY the numbers, names, times and drivers present in the JSON provided. Never invent, round differently, or estimate any figure.',
  '- If a value is null or missing, say it is unavailable — do not guess.',
  '- Risk is on a 0–100 scale. "horizons" are the projected risk now / +1h / +3h / +6h.',
  '- Be concise, concrete and action-oriented. No marketing language, no emojis.',
  '- Lead with the risk level and the single most important action.',
].join('\n');

// Deterministic fallback (and the structure the LLM phrases) so the endpoint
// is useful with or without an API key.
function templateBrief(est) {
  if (!est) return 'No estate data available.';
  const h = est.horizons || {};
  const lvl = est.current_risk >= 80 ? 'CRITICAL' : est.current_risk >= 60 ? 'HIGH' : est.current_risk >= 35 ? 'MODERATE' : 'LOW';
  const drivers = (est.drivers || []).slice(0, 3).map(d => d.label).join('; ') || 'no dominant driver';
  const cw = est.critical_window ? ` Critical risk likely around ${est.critical_window.label}.` : '';
  const anom = est.anomaly ? ` ${est.anomaly.note}` : '';
  return `${est.name}: ${lvl} risk (${est.current_risk}/100). Projected ${h.h1}/${h.h3}/${h.h6} at +1h/+3h/+6h.${cw}${anom} Main drivers: ${drivers}. Recommended action: ${est.recommendation}. Confidence ${est.confidence}%.`;
}

function templatePortfolio(p, top) {
  const lines = [
    `${p.total} estates monitored. ${p.critical_now} critical now, ${p.entering_high_3h} entering high risk within 3h, ${p.preventive_recommended} due preventive maintenance, ${p.anomalies} anomalies flagged.`,
  ];
  top.slice(0, 5).forEach(e => lines.push(`• ${e.name} — ${e.current_risk}→${e.horizons.h3} (3h): ${e.recommendation}`));
  return lines.join('\n');
}

// POST /ai/brief  body: { property_id }  OR  { scope: 'portfolio' }
router.post('/brief', async (req, res) => {
  try {
    const forecast = await buildHorizonForecast();
    const wantPortfolio = (req.body && req.body.scope === 'portfolio') || !(req.body && req.body.property_id);

    let structured, fallback, userPrompt;
    if (wantPortfolio) {
      const top = forecast.estates.slice(0, 8);
      structured = { portfolio: forecast.portfolio, rain_next_3h_mm: forecast.rain_next_3h_mm, generated_at: forecast.generated_at, estates: top };
      fallback = templatePortfolio(forecast.portfolio, forecast.estates);
      userPrompt = 'Write a short morning portfolio briefing (3–5 sentences + a prioritised bullet list of the estates needing action today). Data:\n' + JSON.stringify(structured);
    } else {
      const est = forecast.estates.find(e => String(e.property_id) === String(req.body.property_id));
      if (!est) return res.status(404).json({ success: false, error: 'Property not found in forecast' });
      structured = est;
      fallback = templateBrief(est);
      userPrompt = 'Write a 2–4 sentence risk briefing for this single estate: the risk level and trajectory, the main drivers, and the recommended action. Data:\n' + JSON.stringify(est);
    }

    const ai = await askLLM({ system: SYSTEM, user: userPrompt, maxTokens: wantPortfolio ? 800 : 400 });
    if (ai.ok) {
      return res.json({ success: true, data: { ai: true, provider: ai.provider, model: ai.model, briefing: ai.text, structured } });
    }
    // Graceful: template briefing + a note about why the LLM didn't run.
    return res.json({
      success: true,
      data: {
        ai: false,
        reason: ai.reason,                       // 'no_key' until ANTHROPIC_API_KEY is set
        briefing: fallback,
        structured,
      },
    });
  } catch (err) {
    console.error('POST /ai/brief', err);
    res.status(500).json({ success: false, error: 'Failed to build briefing' });
  }
});

// GET /ai/status — is the LLM layer configured, and with which provider?
router.get('/status', (req, res) => {
  res.json({ success: true, data: { llm_enabled: hasKey(), provider: PROVIDER, model: hasKey() ? MODEL : null } });
});

module.exports = router;
