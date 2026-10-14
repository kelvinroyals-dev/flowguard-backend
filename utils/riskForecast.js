/* ══════════════════════════════════════════════════════════════
   Flood risk forecast — rule-based, not a trained ML model.

   There is no forecasting model in this system. What's real: (1) each
   estate's current sensor-derived risk (same peak/avg-weighted formula
   already used by the client portal's GET /monitoring/flood-risk), and
   (2) estate-coordinate rainfall estimates from the shared weather adapter.
   Missing locations or weather remain unavailable, never a Lagos fallback.

   "Predicted" risk is those two blended with a fixed, documented weight
   — 55% current sensor trend, 45% forecast rainfall intensity — not a
   statistical projection with a real confidence interval. Every place
   this surfaces in the UI says so explicitly, rather than borrowing the
   language of a trained model it doesn't have.
   ══════════════════════════════════════════════════════════════ */

const pool = require('../config/database');
const { computeFeatures } = require('./features');

const estateWeather = require('./estateWeather');
const CURRENT_WEIGHT = 0.55;
const RAIN_WEIGHT = 0.45;
const RAIN_TO_SCORE = 3;   // mm of forecast rain -> risk-score points, capped at 100

// Coordinates are the source of truth for the map — never invented. A property
// is plotted ONLY if it has real lat/long (geocoded from its address on
// registration, or set/confirmed by an operator via the pin tool). Rows with no
// coordinates are returned with latitude/longitude = null so the UI can list
// them under "location not set" and prompt an operator to place the pin, rather
// than guessing a point. `geo_approx` = we have coordinates but no human has
// confirmed them yet (address geocode); it clears once location_verified.

// Score EVERY managed property — not just the ones with Sentinels.
// The forecast is a "brain" that must be useful before a single device is
// installed, then sharpen as they come online. So each property gets:
//   • an ENVIRONMENTAL/HISTORICAL baseline (risk_level, drain health, months
//     since last cleaning/inspection, historical flood events, open incidents)
//     that needs no hardware, and
//   • a LIVE sensor rollup (two-hop sensor -> asset -> estate) blended in when
//     any Sentinel is reporting.
// `has_live` flags which properties are actually monitored; `confidence`
// reflects how much to trust the number; `contributors` explains WHY.
function envScore(p) {
  const c = [];
  let s = 12;
  const rl = String(p.risk_level || '').toLowerCase();
  const rlAdd = rl === 'critical' ? 42 : rl === 'high' ? 28 : rl === 'moderate' ? 14 : rl === 'low' ? 4 : 8;
  s += rlAdd; c.push({ label: `Base risk level: ${rl || 'unrated'}`, delta: rlAdd, dir: 'up' });

  const health = p.health_score != null ? Number(p.health_score) : null;
  if (health != null) {
    if (health < 60) { const a = Math.round((60 - health) * 0.4); s += a; c.push({ label: `Low drain health (${health}/100)`, delta: a, dir: 'up' }); }
    else if (health >= 80) { const a = Math.round((health - 80) * 0.3); s -= a; c.push({ label: `Recorded asset health (${health}/100)`, delta: a, dir: 'down' }); }
  }

  const clean = p.last_cleaning || p.last_inspection;
  if (clean) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(clean).getTime()) / 864e5));
    if (days > 270) { s += 18; c.push({ label: `Drain cleaned ${Math.round(days / 30)} months ago`, delta: 18, dir: 'up' }); }
    else if (days > 120) { s += 10; c.push({ label: `Drain cleaned ${Math.round(days / 30)} months ago`, delta: 10, dir: 'up' }); }
    else if (days < 60) { s -= 10; c.push({ label: 'Recently inspected / cleaned', delta: 10, dir: 'down' }); }
  } else { s += 8; c.push({ label: 'No maintenance record on file', delta: 8, dir: 'up' }); }

  const floods = parseInt(p.flood_events) || 0;
  if (floods > 0) { const a = Math.min(20, floods * 7); s += a; c.push({ label: `Historical flooding (${floods} event${floods === 1 ? '' : 's'})`, delta: a, dir: 'up' }); }

  const alerts = parseInt(p.open_alerts) || 0;
  if (alerts > 0) { const a = Math.min(18, alerts * 8); s += a; c.push({ label: `${alerts} open incident${alerts === 1 ? '' : 's'}`, delta: a, dir: 'up' }); }

  // Terrain (GIS). Low-lying ground and proximity to a water body both raise
  // flood exposure; higher ground and distance lower it. Only applied when the
  // property has been enriched (scripts/backfill-gis.js).
  const elev = p.elevation_m != null ? Number(p.elevation_m) : null;
  if (elev != null) {
    if (elev <= 3) { s += 12; c.push({ label: `Very low-lying (${elev.toFixed(0)}m elevation)`, delta: 12, dir: 'up' }); }
    else if (elev <= 8) { s += 7; c.push({ label: `Low-lying (${elev.toFixed(0)}m elevation)`, delta: 7, dir: 'up' }); }
    else if (elev >= 30) { s -= 6; c.push({ label: `Elevated ground (${elev.toFixed(0)}m)`, delta: 6, dir: 'down' }); }
  }
  const dist = p.distance_to_water_m != null ? Number(p.distance_to_water_m) : null;
  if (dist != null) {
    if (dist <= 150) { s += 12; c.push({ label: `Beside water (~${Math.round(dist)}m)`, delta: 12, dir: 'up' }); }
    else if (dist <= 500) { s += 7; c.push({ label: `Near water (~${Math.round(dist)}m)`, delta: 7, dir: 'up' }); }
    else if (dist >= 3000) { s -= 4; c.push({ label: 'Well away from open water', delta: 4, dir: 'down' }); }
  }

  return { score: Math.max(0, Math.min(100, Math.round(s))), contributors: c };
}

async function scoreProperties(scope={}) {
  const { rows } = await pool.query(`
    SELECT p.property_id, COALESCE(p.property_name, p.asset_code) AS name, p.property_name,
           p.latitude, p.longitude, p.location_verified, p.geocode_source,p.state,p.city,
           p.elevation_m, p.distance_to_water_m,
           p.health_score, p.risk_level, p.user_id, p.last_inspected_at,
           u.full_name AS client_name,
           live.peak_level, live.avg_level, live.sensor_count, live.latest_reading, live.reporting_count,
           (SELECT COUNT(*) FROM alerts a WHERE a.property_id = p.property_id AND a.status = 'active') AS open_alerts,
           (SELECT COUNT(*) FROM property_events e WHERE e.property_id = p.property_id AND e.event_type = 'flood_incident') AS flood_events,
           (SELECT MAX(e.occurred_at) FROM property_events e WHERE e.property_id = p.property_id AND e.event_type IN ('silt_clearing','maintenance')) AS last_cleaning,
           (SELECT MAX(i.completed_at) FROM inspections i WHERE i.property_id = p.property_id AND i.completed_at IS NOT NULL) AS last_inspection
      FROM properties p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN LATERAL (
        SELECT MAX(r.water_level_percent) FILTER (WHERE r.time > NOW() - INTERVAL '30 minutes' AND r.time <= NOW() AND r.water_level_percent BETWEEN 0 AND 100) AS peak_level,
               AVG(r.water_level_percent) FILTER (WHERE r.time > NOW() - INTERVAL '30 minutes' AND r.time <= NOW() AND r.water_level_percent BETWEEN 0 AND 100) AS avg_level,
               COUNT(DISTINCT s.sensor_id) AS sensor_count, MAX(r.time) AS latest_reading,
               COUNT(DISTINCT s.sensor_id) FILTER (WHERE r.time > NOW() - INTERVAL '30 minutes' AND r.time <= NOW() AND r.water_level_percent BETWEEN 0 AND 100)::int AS reporting_count
          FROM sensors s
          JOIN properties asset ON asset.property_id = s.property_id
          LEFT JOIN LATERAL (
            SELECT water_level_percent, time FROM sensor_readings
             WHERE sensor_id = s.sensor_id
             ORDER BY time DESC LIMIT 1
          ) r ON true
         WHERE s.status = 'active' AND s.property_id IS NOT NULL
           AND COALESCE(asset.parent_property_id, asset.property_id) = p.property_id
      ) live ON true
     WHERE (p.asset_class = 'customer_property' OR p.asset_class IS NULL)
       AND p.parent_property_id IS NULL
       AND ($1::text IS NULL OR LOWER(TRIM(p.state))=LOWER($1) OR ($1='Federal Capital Territory' AND LOWER(TRIM(p.state)) IN ('abuja','fct','abuja fct','fct abuja')))
       AND ($2::text IS NULL OR LOWER(p.city)=LOWER($2))
       AND ($3::text IS NULL OR p.property_id=$3)
       AND ($4::text[] IS NULL OR p.property_id=ANY($4))
     ORDER BY p.property_name`,[scope.state||null,scope.city||null,scope.property_id||null,scope.propertyIds||null]);

  return rows.map(r => {
    const env = envScore(r);
    const peak = parseFloat(r.peak_level);
    const avg = parseFloat(r.avg_level);
    const sensorCount = parseInt(r.sensor_count) || 0;
    const hasLive = Number(r.reporting_count) > 0 && Number.isFinite(peak) && Number.isFinite(avg);
    const sensorRisk = hasLive ? Math.round(Math.min(100, peak * 0.7 + avg * 0.3)) : null;
    let lat = r.latitude != null ? Number(r.latitude) : null;
    let lon = r.longitude != null ? Number(r.longitude) : null;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) { lat = null; lon = null; }
    const located = lat != null && lon != null;
    const verified = r.location_verified === true;
    return {
      property_id: r.property_id, name: r.name, client_name: r.client_name,state:r.state,city:r.city,
      latitude: lat, longitude: lon,
      located, location_verified: verified,
      geo_approx: located && !verified,
      geocode_source: r.geocode_source || null,
      has_live: hasLive,
      current_risk: hasLive ? sensorRisk : env.score,
      env_score: env.score,
      env_contributors: env.contributors,
      sensor_count: sensorCount,
      reporting_count: Number(r.reporting_count) || 0,
      data_coverage: null, // Physical estate coverage cannot be inferred from device count.
      assessment_basis: hasLive ? 'recent_telemetry' : 'environmental_baseline',
      telemetry_state: hasLive ? (Number(r.reporting_count) < sensorCount ? 'partial' : 'recent') : r.latest_reading ? 'stale_or_invalid' : 'missing',
      latest_reading: r.latest_reading || null,
      open_incidents: parseInt(r.open_alerts) || 0,
      flood_events: parseInt(r.flood_events) || 0,
      last_cleaning: r.last_cleaning || null,
      last_inspection: r.last_inspection || r.last_inspected_at || null,
      health_score: r.health_score != null ? Number(r.health_score) : null,
    };
  });
}

// Hourly rainfall for a window. `startHour`/`endHour` are offsets from now
// (e.g. 0-24 = "today", 24-48 = "tomorrow"). Returns null on fetch failure
// — callers must handle "no forecast available" rather than fake data.
async function rainfallWindow(startHour,endHour,estate,snapshot) { return estateWeather.window(estate,startHour,endHour,snapshot); }

function recommendationFor(predicted, delta) {
  if (predicted == null) return { text: 'Forecast unavailable — review current conditions and restore weather input', level: 'unavailable' };
  if (predicted >= 85) return { text: 'Dispatch emergency crew NOW', level: 'critical' };
  if (predicted >= 60 && delta > 0) return { text: 'Pre-clean drain network', level: 'warning' };
  if (delta < -5) return { text: 'Improving — routine monitoring', level: 'ok' };
  return { text: 'Monitor as usual', level: 'ok' };
}

// Per-property forecast confidence — how much to trust the number, NOT a
// statistical interval. Weather + history give a usable baseline (~55–70);
// live Sentinels and a recent inspection push it higher.
function confidenceFor(e, hasRain) {
  const sources = [];
  let conf = 50;
  if (hasRain) { conf += 12; sources.push('Weather forecast'); }
  sources.push('Environmental baseline');
  if (e.flood_events > 0 || e.last_cleaning || e.last_inspection) sources.push('Recorded history');
  if (e.has_live) { conf += 26; sources.push('Live Sentinels'); }
  const insp = e.last_inspection && (Date.now() - new Date(e.last_inspection).getTime()) < 90 * 864e5;
  if (insp) { conf += 8; sources.push('Recent inspection'); }
  if (e.flood_events > 0) conf += 4;
  conf = Math.max(38, Math.min(97, Math.round(conf)));
  return { confidence: conf, sources };
}

// Full forecast for a horizon window (in hours from now).
async function buildForecast(startHour, endHour,scope={}) {
  const properties=await scoreProperties(scope);
  const weatherSnapshots=estateWeather.forEstates?await estateWeather.forEstates(properties):new Map();

  const forecastEstates = await Promise.all(properties.map(async e => {
    const rain=await rainfallWindow(startHour,endHour,e,weatherSnapshots.get(String(e.property_id)));
    const cumulativeRain=rain?rain.reduce((sum,h)=>sum+h.mm,0):null;
    const rainScore=rain?Math.min(100,cumulativeRain*RAIN_TO_SCORE):null;
    const rainAdd=rain?Math.round(rainScore*RAIN_WEIGHT):0;
    const predicted = rain ? Math.round(Math.min(100, Math.max(0,
      e.current_risk * CURRENT_WEIGHT + rainScore * RAIN_WEIGHT))) : null;
    const delta = predicted == null ? null : predicted - e.current_risk;
    const rec = recommendationFor(predicted, delta);
    const { confidence, sources } = confidenceFor(e, !!rain);

    // Explainable "why": rainfall driver + the environmental/historical
    // contributors, sorted by magnitude, plus a confidence note about live data.
    const contributors = [];
    if (rainAdd > 0) contributors.push({ label: `Rainfall forecast (${Math.round(cumulativeRain)}mm)`, delta: rainAdd, dir: 'up' });
    (e.env_contributors || []).forEach(c => contributors.push(c));
    contributors.sort((a, b) => (b.delta || 0) - (a.delta || 0));
    contributors.push(e.has_live
      ? { label: 'Live Sentinel data', delta: 0, dir: 'down', note: 'raises confidence' }
      : { label: 'Recent telemetry unavailable', delta: 0, dir: 'down', note: 'current assessment uses environmental baseline; installation is not inferred' });

    return {
      ...e, predicted_risk: predicted, delta,
      forecast_status:rain?'available':'weather_unavailable',cumulative_rain_mm:cumulativeRain,
      weather_series:(rain||[]).map(h=>({t:h.t,rainfall:h.mm,risk:Math.round(Math.min(100,e.current_risk*CURRENT_WEIGHT+Math.min(100,h.mm*RAIN_TO_SCORE*4)*RAIN_WEIGHT))})),
      confidence_kind:'evidence_completeness_not_probability',
      recommendation: rec.text, recommendation_level: rec.level,
      confidence: rain ? confidence : null, confidence_sources: sources,
      contributors: contributors.slice(0, 7),
    };
  }));
  forecastEstates.sort((a,b)=>(b.predicted_risk??-1)-(a.predicted_risk??-1));

  // Charts show one explicitly named estate, never a fictitious national rain sum.
  const reference=forecastEstates.find(e=>e.forecast_status==='available');
  const series=reference?.weather_series||[];
  const available=forecastEstates.filter(e=>e.forecast_status==='available').length;
  const liveCount = forecastEstates.filter(e => e.has_live).length;
  const locatedCount = forecastEstates.filter(e => e.located).length;
  const unverifiedCount = forecastEstates.filter(e => e.geo_approx).length;
  const suppliedConfidence=forecastEstates.filter(e=>e.confidence!=null);
  const portfolioConfidence = suppliedConfidence.length
    ? Math.round(suppliedConfidence.reduce((s,e)=>s+e.confidence,0)/suppliedConfidence.length) : null;

  return {
    method: `Rule-based projection: ${Math.round(CURRENT_WEIGHT * 100)}% current risk (live sensors where installed, else environmental/historical baseline) + ${Math.round(RAIN_WEIGHT * 100)}% forecast rainfall — not a trained model.`,
    has_rainfall_data: available>0,
    cumulative_rain_mm: reference?.cumulative_rain_mm??null,
    weather_scope:'estate',weather_reference:reference?{property_id:reference.property_id,name:reference.name}:null,
    geography:scope,
    weather_coverage:{available,total:forecastEstates.length,unavailable:forecastEstates.length-available},
    forecast_status:available===forecastEstates.length&&available?'available':available?'partial':'weather_unavailable',
    generated_at: new Date().toISOString(),
    telemetry_freshness_minutes: 30,
    live_count: liveCount,
    total_count: forecastEstates.length,
    portfolio_confidence: available ? portfolioConfidence : null,
    confidence_kind:'evidence_completeness_not_probability',
    estates: forecastEstates,
    series,
  };
}

// ── Multi-horizon forecast (now / +1h / +3h / +6h) ────────────────────
// Additive model so "now" ≈ current risk and future horizons rise with
// forecast rainfall and water-level momentum (rate of rise). Still rule-based
// and explainable — every horizon and driver is derived from real figures.
async function rainfallWindows(estate,snapshot) {
  const rain = await rainfallWindow(0, 6, estate,snapshot);
  if (!rain) return null;
  const cum = h => rain.slice(0, h).reduce((s, x) => s + (x.mm || 0), 0);
  return { h1: cum(1), h3: cum(3), h6: cum(6), series: rain };
}

async function buildHorizonForecast(scope={}) {
  const [properties, feats] = await Promise.all([
    scoreProperties(scope), computeFeatures(),
  ]);
  const weatherSnapshots=estateWeather.forEstates?await estateWeather.forEstates(properties):new Map();
  const estates = await Promise.all(properties.map(async e => {
    const rain=await rainfallWindows(e,weatherSnapshots.get(String(e.property_id)));
    const cum=h=>rain?(h===1?rain.h1:h===3?rain.h3:rain.h6):0;
    const f = feats.get(e.property_id) || {};
    const base = e.current_risk;
    const rise = f.rise_rate_pph != null ? f.rise_rate_pph : 0;

    function predict(h) {
      if (!rain) return null;
      const rainAdd = Math.round(Math.min(100, cum(h) * RAIN_TO_SCORE) * RAIN_WEIGHT);
      const momentum = Math.round(Math.max(0, rise) * h * 0.6);              // rising water keeps pushing risk up
      const relief = (rise < 0 && cum(h) < 3) ? Math.round(Math.min(-rise * h * 0.4, 8)) : 0;  // falling + dry = improving
      return Math.max(0, Math.min(100, base + rainAdd + momentum - relief));
    }
    const horizons = { now: Math.round(base), h1: predict(1), h3: predict(3), h6: predict(6) };
    const peak = Math.max(horizons.now, horizons.h1, horizons.h3, horizons.h6);
    const delta = horizons.h3 == null ? null : horizons.h3 - horizons.now;

    let critical = null;
    if (horizons.now >= 80) critical = { in_hours: 0, at: new Date().toISOString(), label: 'now' };
    for (const h of critical ? [] : [1, 3, 6]) {
      if (predict(h) >= 80) {
        const at = new Date(Date.now() + h * 3600e3);
        critical = { in_hours: h, at: at.toISOString(), label: at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) };
        break;
      }
    }
    if (!critical && horizons.now >= 80) critical = { in_hours: 0, at: new Date().toISOString(), label: 'now' };

    // Blockage anomaly: water rising fast with little/no rain -> downstream restriction.
    const onsiteRain = f.rain_onsite_1h;
    const anomaly = (rain && onsiteRain != null && rise >= 6 && onsiteRain < 2 && cum(1) < 2)
      ? { type: 'blockage_suspected', note: `Water rising ${rise}%/hr with little rain — possible blockage or downstream restriction.` }
      : null;

    const drivers = [];
    const rainAdd3 = Math.round(Math.min(100, cum(3) * RAIN_TO_SCORE) * RAIN_WEIGHT);
    if (rainAdd3 > 0) drivers.push({ label: `Rainfall forecast (${Math.round(cum(3))}mm / 3h)`, delta: rainAdd3, dir: 'up' });
    if (rise >= 2) drivers.push({ label: `Water level rising ${rise}%/hr`, delta: Math.round(rise * 1.8), dir: 'up' });
    if (f.silt_now != null && f.silt_now >= 50) drivers.push({ label: `Silt at ${Math.round(f.silt_now)}mm${(f.silt_change_30d || 0) > 5 ? ` (up ${Math.round(f.silt_change_30d)}mm/30d)` : ''}`, delta: 9, dir: 'up' });
    (e.env_contributors || []).forEach(c => drivers.push(c));
    if (anomaly) drivers.unshift({ label: 'Rising with no rain — blockage suspected', delta: 14, dir: 'up' });
    drivers.sort((a, b) => (b.delta || 0) - (a.delta || 0));

    let rec;
    if (anomaly) rec = { text: 'Investigate blockage / downstream restriction', level: 'critical' };
    else if (f.silt_now != null && f.silt_now >= 60 && cum(3) >= 12) rec = { text: 'Prioritise desilting before the rainfall event', level: 'warning' };
    else rec = recommendationFor(horizons.h3, delta);

    const { confidence, sources } = confidenceFor(e, !!rain);
    return {
      property_id: e.property_id, name: e.name, client_name: e.client_name,
      latitude: e.latitude, longitude: e.longitude, located: e.located, has_live: e.has_live,
      current_risk: horizons.now, horizons, peak_risk: peak, delta,
      assessment_basis: e.assessment_basis, telemetry_state: e.telemetry_state,
      latest_reading: e.latest_reading, sensor_count: e.sensor_count, reporting_count: e.reporting_count,
      forecast_status: rain ? 'available' : 'weather_unavailable',
      rain_next_3h_mm:rain?rain.h3:null,confidence_kind:'evidence_completeness_not_probability',
      critical_window: critical, anomaly,
      drivers: drivers.slice(0, 6),
      recommendation: rec.text, recommendation_level: rec.level,
      confidence: rain ? confidence : null, confidence_sources: sources,
      features: {
        level_now: f.level_now, rise_rate_pph: f.rise_rate_pph,
        silt_now: f.silt_now, net_flow: f.net_flow, rain_onsite_1h: f.rain_onsite_1h,
      },
    };
  }));
  estates.sort((a,b)=>b.peak_risk-a.peak_risk);
  return {...summarizeHorizons(estates),geography:scope};
}

// Build the portfolio-triage envelope from an estates array. Shared so a
// client-scoped subset gets the SAME triage maths as the full ops portfolio.
function summarizeHorizons(estates) {
  const available=estates.filter(e=>e.forecast_status==='available').length;
  const rain=available>0;
  const critical_now = estates.filter(e => e.horizons.now >= 80);
  const entering_high = estates.filter(e => e.horizons.now < 70 && e.horizons.h3 >= 70);
  const preventive = estates.filter(e => e.horizons.now < 60 && e.horizons.h6 >= 60 && e.horizons.h6 < 80);
  const anomalies = estates.filter(e => e.anomaly);

  return {
    method: `Horizon projection (now / +1h / +3h / +6h): current risk + forecast rainfall (${Math.round(RAIN_WEIGHT * 100)}% weight) + water-level momentum. Rule-based, not a trained model.`,
    has_rainfall_data: !!rain,
    forecast_status:available===estates.length&&available?'available':available?'partial':'weather_unavailable',
    rain_next_3h_mm: null,weather_scope:'estate',
    weather_coverage:{available,total:estates.length,unavailable:estates.length-available},
    confidence_kind:'evidence_completeness_not_probability',
    generated_at: new Date().toISOString(),
    portfolio: {
      total: estates.length,
      critical_now: critical_now.length,
      entering_high_3h: rain ? entering_high.length : null,
      preventive_recommended: rain ? preventive.length : null,
      anomalies: rain ? anomalies.length : null,
      needs_action_today: rain ? critical_now.length + entering_high.length : null,
    },
    estates,
  };
}

// Re-scope an already-built horizon forecast to a subset of property_ids
// (client isolation). Recomputes the portfolio triage over just those estates.
function scopeHorizonsToProperties(forecast, propertyIds) {
  const allow = new Set((propertyIds || []).map(String));
  const estates = (forecast.estates || []).filter(e => allow.has(String(e.property_id)));
  return summarizeHorizons(estates);
}

module.exports = {
  scoreProperties, rainfallWindow, buildForecast, buildHorizonForecast,
  summarizeHorizons, scopeHorizonsToProperties, rainfallWindows,
};
