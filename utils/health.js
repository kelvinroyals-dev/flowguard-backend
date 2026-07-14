// utils/health.js — health scoring for ASSETS, rolled up to properties.
//
// Health belongs to the ASSET. A catch basin silted at 84% and a clear canal
// must not average into one meaningless estate number — that hides both facts.
// So: score each drainage asset from what its own Sentinels measure, then roll
// those up (worst-weighted) into the customer property's score.
const pool = require('../config/database');

// ── An asset's health, from the Sentinels that actually watch it ──
//   water level 35% · silt 30% · alerts 20% · node network 15%
async function computeAssetHealth(assetId) {
  const parts = [];
  const components = {};

  // latest reading from every Sentinel covering this asset
  const { rows: reads } = await pool.query(`
    SELECT s.sensor_id, s.status, s.last_ping,
           r.water_level_percent AS level, r.silt_depth_mm AS silt,
           r.debris_detected AS debris
      FROM sentinel_coverage sc
      JOIN sensors s ON s.sensor_id = sc.sensor_id
      LEFT JOIN LATERAL (
        SELECT water_level_percent, silt_depth_mm, debris_detected
          FROM sensor_readings WHERE sensor_id = s.sensor_id
          ORDER BY time DESC LIMIT 1
      ) r ON true
     WHERE sc.property_id = $1`, [assetId]);

  if (reads.length) {
    // node network: are the devices watching this asset actually alive?
    // status alone isn't enough — it's set once at registration and never
    // updated by ingestion, so a silent node would otherwise still score
    // as "online" and hide the fact that the asset isn't really monitored.
    const online = reads.filter(x =>
      x.status === 'active' && x.last_ping && new Date(x.last_ping) > new Date(Date.now() - 6 * 60 * 60 * 1000)
    ).length;
    components.network = Math.round((online / reads.length) * 100);
    parts.push([components.network, .15]);

    // water level: use the WORST reading across covering nodes, not the mean —
    // one flooding sensor on an asset means the asset is flooding.
    const levels = reads.map(x => x.level).filter(v => v != null).map(Number);
    if (levels.length) {
      const worst = Math.max(...levels);
      components.water_level = worst;
      parts.push([Math.max(0, 100 - worst), .35]);
    }

    // silt: capacity lost to sediment (assume 500mm nominal channel depth)
    const silts = reads.map(x => x.silt).filter(v => v != null).map(Number);
    if (silts.length) {
      const worstSilt = Math.max(...silts);
      const siltPct = Math.min(100, (worstSilt / 500) * 100);
      components.silt_pct = Math.round(siltPct);
      parts.push([Math.max(0, 100 - siltPct), .30]);
    }
    if (reads.some(x => x.debris)) components.debris = true;
  }

  // open alerts raised against THIS asset
  const { rows: al } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM alerts
     WHERE property_id = $1 AND status NOT IN ('resolved','closed')`, [assetId]);
  components.open_alerts = al[0] ? al[0].n : 0;
  parts.push([Math.max(0, 100 - components.open_alerts * 15), .20]);

  if (parts.length < 2) return null;   // alerts alone is not a score
  const tw = parts.reduce((s, p) => s + p[1], 0);
  const score = Math.round(parts.reduce((s, p) => s + p[0] * p[1], 0) / tw);
  return { score: Math.max(0, Math.min(100, score)), components };
}

// ── A customer property's health = a roll-up of its assets ──
// Worst-weighted, not a plain mean: an estate is only as protected as its
// weakest drain. 60% worst asset, 40% average — so one failing basin drags
// the score without a fleet of healthy ones hiding it.
async function computePropertyHealth(propertyId) {
  const { rows: assets } = await pool.query(
    `SELECT property_id FROM properties
      WHERE parent_property_id = $1 AND asset_class = 'drainage_asset'`, [propertyId]);

  if (assets.length) {
    const scores = [];
    const weakest = { id: null, score: 101 };
    for (const a of assets) {
      const h = await computeAssetHealth(a.property_id);
      if (!h) continue;
      scores.push(h.score);
      if (h.score < weakest.score) { weakest.score = h.score; weakest.id = a.property_id; }
    }
    if (scores.length) {
      const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
      const score = Math.round(weakest.score * 0.6 + avg * 0.4);
      return {
        score: Math.max(0, Math.min(100, score)),
        components: {
          basis: 'assets',
          asset_count: scores.length,
          weakest_asset: weakest.id,
          weakest_score: weakest.score,
          average_score: Math.round(avg),
        },
      };
    }
  }

  // No assets registered yet — fall back to the old inspection-report signal
  // rather than pretending we can't score the property at all.
  const { rows: rep } = await pool.query(`
    SELECT i.drainage_condition_score AS s
      FROM inspection_reports ir JOIN inspections i ON i.inspection_id = ir.inspection_id
     WHERE ir.property_id = $1 AND i.drainage_condition_score IS NOT NULL
     ORDER BY ir.created_at DESC LIMIT 1`, [propertyId]);
  if (!rep[0]) return null;
  return {
    score: Math.round(Number(rep[0].s)),
    components: { basis: 'inspection_report_only', report: Number(rep[0].s) },
  };
}

// snapshot every property AND every asset once per day (idempotent)
async function snapshotAll() {
  try {
    const { rows: all } = await pool.query(
      `SELECT property_id, asset_class FROM properties`);
    let n = 0;
    for (const p of all) {
      const h = p.asset_class === 'drainage_asset'
        ? await computeAssetHealth(p.property_id)
        : await computePropertyHealth(p.property_id);
      if (!h) continue;
      await pool.query(`
        INSERT INTO health_history (property_id, score, components)
        VALUES ($1, $2, $3)
        ON CONFLICT (property_id, recorded_at) DO UPDATE
          SET score = EXCLUDED.score, components = EXCLUDED.components`,
        [p.property_id, h.score, JSON.stringify(h.components)]);
      // mirror onto the row so screens can read a score without a history join
      await pool.query(
        `UPDATE properties SET health_score = $2, health_updated_at = NOW() WHERE property_id = $1`,
        [p.property_id, h.score]);
      n++;
    }
    console.log(`[health] snapshot complete — ${n} scored (properties + assets)`);
  } catch (err) { console.error('[health] snapshot failed:', err.message); }
}

function startDailySnapshots() {
  snapshotAll();                                  // on boot (fills today if missing)
  setInterval(snapshotAll, 24 * 60 * 60 * 1000);  // then daily
}

module.exports = { computeAssetHealth, computePropertyHealth, snapshotAll, startDailySnapshots };
