/* ══════════════════════════════════════════════════════════════
   Asset health — scored where it belongs.

   The old model scored a customer property from its reports, nodes and
   alerts. But a property doesn't flood: its CATCH BASIN does. An estate
   with a clear canal and a basin choked at 84% silt averaged to "68",
   a number describing neither, and hiding the one thing a crew should
   go and fix.

   Now each drainage asset carries its own score, driven by what its
   Sentinels actually measure, and the property's score is the roll-up —
   weighted toward its worst asset, because a network is only as good as
   its weakest link. An estate is not "fine on average" when one basin
   is about to overflow.
   ══════════════════════════════════════════════════════════════ */
const pool = require('../config/database');

// Score one asset from its latest telemetry + open alerts.
// Returns { score, drivers } — drivers names WHY, so the ops portal can
// say "CB-12 is at 42 because silt is 84% and its node is offline".
async function scoreAsset(propertyId) {
  const { rows } = await pool.query(`
    SELECT p.property_id, p.property_type,
           s.sensor_id, s.status AS node_status,
           r.water_level_percent, r.silt_depth_mm, r.debris_detected, r.time AS reading_time
      FROM properties p
      LEFT JOIN sentinel_coverage sc ON sc.property_id = p.property_id
      LEFT JOIN sensors s  ON s.sensor_id = sc.sensor_id
      LEFT JOIN LATERAL (
        SELECT water_level_percent, silt_depth_mm, debris_detected, time
          FROM sensor_readings WHERE sensor_id = s.sensor_id
          ORDER BY time DESC LIMIT 1
      ) r ON true
     WHERE p.property_id = $1`, [propertyId]);

  if (!rows.length) return null;

  const { rows: alertRows } = await pool.query(`
    SELECT severity FROM alerts
     WHERE property_id = $1 AND status NOT IN ('resolved','closed')`, [propertyId]);

  const nodes = rows.filter(r => r.sensor_id);
  const drivers = [];
  let score = 100;

  // ── no eyes on it: we cannot claim an asset is healthy if nothing watches it ──
  if (!nodes.length) {
    drivers.push({ factor: 'unmonitored', penalty: 25, detail: 'No Sentinel covers this asset' });
    score -= 25;
  } else {
    const offline = nodes.filter(n => n.node_status !== 'active').length;
    if (offline) {
      const p = Math.min(20, offline * 12);
      drivers.push({ factor: 'node_offline', penalty: p, detail: `${offline} Sentinel${offline > 1 ? 's' : ''} offline` });
      score -= p;
    }
    const silent = nodes.filter(n => n.sensor_id && !n.reading_time).length;
    if (silent === nodes.length) {
      drivers.push({ factor: 'no_telemetry', penalty: 15, detail: 'No readings received' });
      score -= 15;
    }

    // ── water level: the closer to capacity, the worse ──
    const levels = nodes.map(n => n.water_level_percent).filter(v => v != null).map(Number);
    if (levels.length) {
      const peak = Math.max(...levels);
      if (peak >= 85)      { drivers.push({ factor: 'water_level', penalty: 35, detail: `Water at ${Math.round(peak)}% of capacity` }); score -= 35; }
      else if (peak >= 70) { drivers.push({ factor: 'water_level', penalty: 22, detail: `Water at ${Math.round(peak)}%` }); score -= 22; }
      else if (peak >= 50) { drivers.push({ factor: 'water_level', penalty: 10, detail: `Water at ${Math.round(peak)}%` }); score -= 10; }
    }

    // ── silt: the thing a crew is dispatched to clear ──
    const silts = nodes.map(n => n.silt_depth_mm).filter(v => v != null).map(Number);
    if (silts.length) {
      const worst = Math.max(...silts);
      // treated as a depth in mm; >200mm is a heavily choked drain
      if (worst >= 200)      { drivers.push({ factor: 'silt', penalty: 25, detail: `Silt at ${worst}mm — clearing overdue` }); score -= 25; }
      else if (worst >= 120) { drivers.push({ factor: 'silt', penalty: 14, detail: `Silt at ${worst}mm` }); score -= 14; }
    }

    if (nodes.some(n => n.debris_detected)) {
      drivers.push({ factor: 'debris', penalty: 12, detail: 'Debris detected' });
      score -= 12;
    }
  }

  // ── open alerts on this asset ──
  const crit = alertRows.filter(a => a.severity === 'critical').length;
  const high = alertRows.filter(a => a.severity === 'high').length;
  if (crit) { const p = Math.min(30, crit * 20); drivers.push({ factor: 'critical_alert', penalty: p, detail: `${crit} critical alert${crit > 1 ? 's' : ''} open` }); score -= p; }
  if (high) { const p = Math.min(15, high * 8);  drivers.push({ factor: 'high_alert', penalty: p, detail: `${high} high alert${high > 1 ? 's' : ''} open` }); score -= p; }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, drivers };
}

/* Roll a property's score up from its assets.
   Deliberately NOT a plain average: an estate with nine healthy drains
   and one basin about to overflow is not 90% healthy. We weight the
   worst asset heavily — the network fails where it is weakest. */
function rollUp(assetScores) {
  if (!assetScores.length) return null;
  const worst = Math.min(...assetScores);
  const mean = assetScores.reduce((a, b) => a + b, 0) / assetScores.length;
  return Math.round(worst * 0.6 + mean * 0.4);
}

async function scoreProperty(propertyId) {
  const { rows: assets } = await pool.query(
    `SELECT property_id FROM properties
      WHERE parent_property_id = $1 AND asset_class = 'drainage_asset'`, [propertyId]);

  const scores = [];
  for (const a of assets) {
    const r = await scoreAsset(a.property_id);
    if (!r) continue;
    scores.push(r.score);
    await pool.query(
      `UPDATE properties SET health_score = $2, health_updated_at = NOW() WHERE property_id = $1`,
      [a.property_id, r.score]);
    await pool.query(`
      INSERT INTO asset_health_history (property_id, score, drivers)
      VALUES ($1,$2,$3)
      ON CONFLICT (property_id, recorded_at) DO UPDATE
        SET score = EXCLUDED.score, drivers = EXCLUDED.drivers`,
      [a.property_id, r.score, JSON.stringify(r.drivers)]);
  }

  const rolled = rollUp(scores);
  if (rolled != null) {
    await pool.query(
      `UPDATE properties SET health_score = $2, health_updated_at = NOW() WHERE property_id = $1`,
      [propertyId, rolled]);
    await pool.query(`
      INSERT INTO asset_health_history (property_id, score, drivers)
      VALUES ($1,$2,$3)
      ON CONFLICT (property_id, recorded_at) DO UPDATE SET score = EXCLUDED.score`,
      [propertyId, rolled, JSON.stringify([{ factor: 'rollup', detail: `From ${scores.length} asset(s), worst ${Math.min(...scores)}` }])]);
  }
  return { property_id: propertyId, score: rolled, assets: scores.length };
}

async function scoreAll() {
  const { rows } = await pool.query(
    `SELECT property_id FROM properties WHERE asset_class = 'customer_property'`);
  let done = 0;
  for (const p of rows) {
    try { await scoreProperty(p.property_id); done++; } catch (e) { console.error('[health] ' + p.property_id, e.message); }
  }
  console.log(`[health] scored ${done} propert${done === 1 ? 'y' : 'ies'} and their assets`);
  return done;
}

function startHealthEngine() {
  scoreAll();
  setInterval(scoreAll, 60 * 60 * 1000);   // hourly — health moves with telemetry
  console.log('[health] asset health engine started (hourly)');
}

module.exports = { scoreAsset, scoreProperty, scoreAll, rollUp, startHealthEngine };
