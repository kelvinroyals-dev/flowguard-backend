/* ══════════════════════════════════════════════════════════════
   Feature engine — turns raw sensor_readings time-series into the
   rolling / rate features the risk model actually reasons over.

   Real research on urban flood prediction combines rainfall with
   "water-level memory" (rate of rise, recent averages) rather than the
   instantaneous level alone — that's what this computes, per ESTATE,
   rolling every sensor up two hops (sensor -> asset -> parent estate),
   the same mapping riskForecast.js uses.

   Every value can be null (a property with no live sensors) — callers
   must treat null as "no signal", never as zero.
   ══════════════════════════════════════════════════════════════ */

const pool = require('../config/database');

function num(v) { return v == null || v === '' || isNaN(Number(v)) ? null : Number(v); }

// Returns a Map<property_id, features>. One grouped scan of the last 30 days
// of readings, using FILTER windows so it's a single query, not N.
async function computeFeatures() {
  const { rows } = await pool.query(`
    SELECT COALESCE(asset.parent_property_id, asset.property_id) AS estate,
           AVG(r.water_level_percent) FILTER (WHERE r.time > NOW() - INTERVAL '15 minutes')                                   AS level_now,
           AVG(r.water_level_percent) FILTER (WHERE r.time BETWEEN NOW() - INTERVAL '75 minutes' AND NOW() - INTERVAL '45 minutes') AS level_1h_ago,
           AVG(r.water_level_percent) FILTER (WHERE r.time > NOW() - INTERVAL '6 hours')                                      AS level_avg_6h,
           MAX(r.water_level_percent) FILTER (WHERE r.time > NOW() - INTERVAL '6 hours')                                      AS level_max_6h,
           AVG(r.silt_depth_mm)       FILTER (WHERE r.time > NOW() - INTERVAL '6 hours')                                      AS silt_now,
           AVG(r.silt_depth_mm)       FILTER (WHERE r.time BETWEEN NOW() - INTERVAL '31 days' AND NOW() - INTERVAL '29 days') AS silt_30d_ago,
           AVG(r.inflow_rate)         FILTER (WHERE r.time > NOW() - INTERVAL '30 minutes')                                   AS inflow_now,
           AVG(r.outflow_rate)        FILTER (WHERE r.time > NOW() - INTERVAL '30 minutes')                                   AS outflow_now,
           AVG(r.rainfall_mm)         FILTER (WHERE r.time > NOW() - INTERVAL '1 hour')                                       AS rain_onsite_1h,
           COUNT(*)                   FILTER (WHERE r.time > NOW() - INTERVAL '6 hours')                                      AS n_6h,
           MAX(r.time)                                                                                                        AS latest
      FROM sensor_readings r
      JOIN sensors s     ON s.sensor_id = r.sensor_id
      JOIN properties asset ON asset.property_id = s.property_id
     WHERE r.time > NOW() - INTERVAL '31 days'
       AND s.status = 'active' AND s.property_id IS NOT NULL
     GROUP BY COALESCE(asset.parent_property_id, asset.property_id)`);

  const map = new Map();
  for (const r of rows) {
    const level_now = num(r.level_now);
    const level_1h_ago = num(r.level_1h_ago);
    const silt_now = num(r.silt_now);
    const silt_30d_ago = num(r.silt_30d_ago);
    const inflow_now = num(r.inflow_now);
    const outflow_now = num(r.outflow_now);

    const level_change_1h = (level_now != null && level_1h_ago != null) ? +(level_now - level_1h_ago).toFixed(1) : null;
    map.set(r.estate, {
      level_now, level_1h_ago,
      level_change_1h,
      rise_rate_pph: level_change_1h,                       // %/hr — positive = rising
      level_avg_6h: num(r.level_avg_6h),
      level_max_6h: num(r.level_max_6h),
      silt_now,
      silt_change_30d: (silt_now != null && silt_30d_ago != null) ? +(silt_now - silt_30d_ago).toFixed(1) : null,
      inflow_now, outflow_now,
      net_flow: (inflow_now != null && outflow_now != null) ? +(inflow_now - outflow_now).toFixed(1) : null,
      rain_onsite_1h: num(r.rain_onsite_1h),
      readings_6h: parseInt(r.n_6h) || 0,
      latest: r.latest || null,
    });
  }
  return map;
}

module.exports = { computeFeatures };
