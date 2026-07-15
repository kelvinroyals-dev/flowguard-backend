/* ══════════════════════════════════════════════════════════════
   Flood risk forecast — rule-based, not a trained ML model.

   There is no forecasting model in this system. What's real: (1) each
   estate's current sensor-derived risk (same peak/avg-weighted formula
   already used by the client portal's GET /monitoring/flood-risk), and
   (2) a Lagos-wide rainfall forecast from Open-Meteo (same source and
   coordinates already used by the ops dashboard's rainfall chart).

   "Predicted" risk is those two blended with a fixed, documented weight
   — 55% current sensor trend, 45% forecast rainfall intensity — not a
   statistical projection with a real confidence interval. Every place
   this surfaces in the UI says so explicitly, rather than borrowing the
   language of a trained model it doesn't have.
   ══════════════════════════════════════════════════════════════ */

const pool = require('../config/database');

const LAGOS = { lat: 6.45, lon: 3.47 };   // same point the dashboard's rainfall chart already uses
const CURRENT_WEIGHT = 0.55;
const RAIN_WEIGHT = 0.45;
const RAIN_TO_SCORE = 3;   // mm of forecast rain -> risk-score points, capped at 100

// Current risk per ESTATE (top-level property), rolled up from whichever
// asset its Sentinels are actually mounted on — mirrors the two-hop
// sensor -> asset -> parent estate relationship already used in
// routes/properties.js's /network endpoint and the coverage PUT handler.
async function currentRiskByEstate() {
  const { rows } = await pool.query(`
    SELECT est.property_id, COALESCE(est.asset_code, est.property_name) AS name,
           est.latitude, est.longitude,
           MAX(r.water_level_percent) AS peak_level,
           AVG(r.water_level_percent) AS avg_level,
           COUNT(DISTINCT s.sensor_id) AS sensor_count,
           MAX(r.time) AS latest_reading
      FROM sensors s
      JOIN properties asset ON asset.property_id = s.property_id
      JOIN properties est   ON est.property_id = COALESCE(asset.parent_property_id, asset.property_id)
      LEFT JOIN LATERAL (
        SELECT water_level_percent, time FROM sensor_readings
         WHERE sensor_id = s.sensor_id AND time > NOW() - INTERVAL '6 hours'
         ORDER BY time DESC LIMIT 1
      ) r ON true
     WHERE s.status = 'active' AND s.property_id IS NOT NULL
     GROUP BY est.property_id, est.asset_code, est.property_name, est.latitude, est.longitude
    HAVING COUNT(r.water_level_percent) > 0
     ORDER BY 1`);

  return rows.map(r => {
    const peak = parseFloat(r.peak_level) || 0;
    const avg = parseFloat(r.avg_level) || 0;
    const sensorCount = parseInt(r.sensor_count) || 0;
    return {
      property_id: r.property_id, name: r.name,
      latitude: r.latitude, longitude: r.longitude,
      current_risk: Math.round(Math.min(100, peak * 0.7 + avg * 0.3)),
      sensor_count: sensorCount,
      latest_reading: r.latest_reading,
      // proxy for how much to trust this number — more nodes reporting
      // recently = more coverage, NOT a statistical confidence interval.
      data_coverage: Math.min(100, sensorCount * 25),
    };
  });
}

// Hourly rainfall for a window. `startHour`/`endHour` are offsets from now
// (e.g. 0-24 = "today", 24-48 = "tomorrow"). Returns null on fetch failure
// — callers must handle "no forecast available" rather than fake data.
async function rainfallWindow(startHour, endHour) {
  try {
    const hours = Math.min(168, endHour);
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${LAGOS.lat}&longitude=${LAGOS.lon}` +
      `&hourly=precipitation,precipitation_probability&timezone=Africa%2FLagos&forecast_hours=${hours}`);
    if (!r.ok) return null;
    const j = await r.json();
    const all = j.hourly.time.map((t, i) => ({
      t, mm: j.hourly.precipitation[i] || 0, prob: j.hourly.precipitation_probability[i] || 0,
    }));
    return all.slice(startHour, endHour);
  } catch (err) {
    console.error('[riskForecast] rainfall fetch failed:', err.message);
    return null;
  }
}

function recommendationFor(predicted, delta) {
  if (predicted >= 85) return { text: 'Dispatch emergency crew NOW', level: 'critical' };
  if (predicted >= 60 && delta > 0) return { text: 'Pre-clean drain network', level: 'warning' };
  if (delta < -5) return { text: 'Improving — routine monitoring', level: 'ok' };
  return { text: 'Monitor as usual', level: 'ok' };
}

// Full forecast for a horizon window (in hours from now).
async function buildForecast(startHour, endHour) {
  const [estates, rain] = await Promise.all([
    currentRiskByEstate(),
    rainfallWindow(startHour, endHour),
  ]);

  const cumulativeRain = rain ? rain.reduce((sum, h) => sum + h.mm, 0) : 0;
  const rainScore = Math.min(100, cumulativeRain * RAIN_TO_SCORE);

  const forecastEstates = estates.map(e => {
    const predicted = Math.round(Math.min(100, Math.max(0,
      e.current_risk * CURRENT_WEIGHT + rainScore * RAIN_WEIGHT)));
    const delta = predicted - e.current_risk;
    const rec = recommendationFor(predicted, delta);
    return { ...e, predicted_risk: predicted, delta, recommendation: rec.text, recommendation_level: rec.level };
  }).sort((a, b) => b.predicted_risk - a.predicted_risk);

  // network-wide hourly series for the chart: same rain-driven blend,
  // applied to the network's average current risk hour by hour.
  const avgCurrent = estates.length
    ? estates.reduce((s, e) => s + e.current_risk, 0) / estates.length : 0;
  const series = (rain || []).map(h => {
    const hourScore = Math.min(100, h.mm * RAIN_TO_SCORE * 4); // single-hour rain hits harder than the cumulative average
    const risk = Math.round(Math.min(100, Math.max(0, avgCurrent * CURRENT_WEIGHT + hourScore * RAIN_WEIGHT)));
    return { t: h.t, risk, rainfall: h.mm };
  });

  return {
    method: `Rule-based projection: ${Math.round(CURRENT_WEIGHT * 100)}% current sensor trend + ${Math.round(RAIN_WEIGHT * 100)}% forecast rainfall intensity — not a trained model.`,
    has_rainfall_data: !!rain,
    cumulative_rain_mm: Math.round(cumulativeRain * 10) / 10,
    estates: forecastEstates,
    series,
  };
}

module.exports = { currentRiskByEstate, rainfallWindow, buildForecast, LAGOS };
