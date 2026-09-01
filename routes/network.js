// routes/network.js — FlowGuard's digital twin of the drainage network.
// Returns the whole graph (assets + topology + properties + outfalls + water
// bodies + zones + summary). Tracing is done client-side over downstream_asset_id.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');

const router = express.Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

const num = v => v == null ? null : Number(v);
function conditionLabel(h) {
  if (h == null) return null;
  return h >= 75 ? 'Good' : h >= 50 ? 'Fair' : h >= 30 ? 'Poor' : 'Critical';
}
function needsAttention(a) {
  const r = (a.risk_level || '').toLowerCase();
  if (r === 'high' || r === 'critical') return true;
  if (a.health_score != null && a.health_score < 50) return true;
  if (a.last_inspected_at && (Date.now() - new Date(a.last_inspected_at).getTime()) > 180 * 864e5) return true;
  if (a.sentinel_count === 0) return true;
  return false;
}

// GET /network/graph
router.get('/graph', async (req, res) => {
  try {
    const [assetsRes, propsRes, wbRes, devCount] = await Promise.all([
      pool.query(`
        SELECT p.property_id, p.asset_code, p.property_name, p.property_type, p.zone,
               p.parent_property_id, parent.property_name AS estate_name,
               p.latitude, p.longitude, p.length_m, p.width_m, p.depth_m, p.material,
               p.flow_direction, p.capacity_liters, p.health_score, p.risk_level,
               p.downstream_asset_id, p.water_body_id, p.location_verified,
               p.topology_verified, p.dimensions_verified, p.last_inspected_at,
               (SELECT COUNT(DISTINCT sc.sensor_id) FROM sentinel_coverage sc WHERE sc.property_id = p.property_id)::int AS sentinel_count,
               (SELECT MAX(r.water_level_percent) FROM sentinel_coverage sc
                  JOIN sensor_readings r ON r.sensor_id = sc.sensor_id
                 WHERE sc.property_id = p.property_id AND r.time > NOW() - INTERVAL '6 hours') AS water_level,
               (SELECT MAX(e.occurred_at) FROM property_events e
                 WHERE e.property_id = p.property_id AND e.event_type IN ('silt_clearing','maintenance','node_repair')) AS last_maintenance
          FROM properties p
          LEFT JOIN properties parent ON parent.property_id = p.parent_property_id
         WHERE p.asset_class = 'drainage_asset'
         ORDER BY p.property_type, p.asset_code`),
      pool.query(`
        SELECT p.property_id, p.property_name, p.zone, p.latitude, p.longitude,
               p.risk_level, p.health_score, p.downstream_asset_id, p.location_verified,
               (SELECT COUNT(DISTINCT sc.sensor_id) FROM sentinel_coverage sc
                  JOIN properties a ON a.property_id = sc.property_id
                 WHERE COALESCE(a.parent_property_id, a.property_id) = p.property_id)::int AS sentinel_count
          FROM properties p
         WHERE (p.asset_class = 'customer_property' OR p.asset_class IS NULL)
           AND p.parent_property_id IS NULL`),
      pool.query(`SELECT * FROM water_bodies ORDER BY name`),
      pool.query(`SELECT COUNT(*)::int AS n FROM sensors`),
    ]);

    const assets = assetsRes.rows.map(a => ({
      ...a,
      water_level: num(a.water_level),
      condition: conditionLabel(a.health_score),
      is_outfall: a.property_type === 'outfall',
      needs_attention: needsAttention(a),
    }));
    const properties = propsRes.rows;
    const water_bodies = wbRes.rows;

    // Zones — aggregate assets + properties by zone.
    const zoneMap = {};
    const zget = z => (zoneMap[z] = zoneMap[z] || { zone: z, asset_count: 0, length_m: 0, sentinel_count: 0, property_count: 0, worst_risk: 0, health_sum: 0, health_n: 0, attention: 0 });
    const riskRank = r => ({ low: 1, moderate: 2, medium: 2, high: 3, critical: 4 }[(r || '').toLowerCase()] || 0);
    assets.forEach(a => {
      const z = zget(a.zone || 'Unzoned');
      z.asset_count++; z.length_m += a.length_m || 0; z.sentinel_count += a.sentinel_count || 0;
      z.worst_risk = Math.max(z.worst_risk, riskRank(a.risk_level));
      if (a.health_score != null) { z.health_sum += a.health_score; z.health_n++; }
      if (a.needs_attention) z.attention++;
    });
    properties.forEach(p => { zget(p.zone || 'Unzoned').property_count++; });
    const riskLabel = n => ['—', 'Low', 'Moderate', 'High', 'Critical'][n] || '—';
    const zones = Object.values(zoneMap).map(z => ({
      zone: z.zone, asset_count: z.asset_count, property_count: z.property_count,
      length_km: Math.round(z.length_m / 100) / 10, sentinel_count: z.sentinel_count,
      attention: z.attention, risk: riskLabel(z.worst_risk),
      condition: conditionLabel(z.health_n ? Math.round(z.health_sum / z.health_n) : null),
    })).sort((a, b) => b.asset_count - a.asset_count);

    const totalLenM = assets.reduce((s, a) => s + (a.length_m || 0), 0);
    const summary = {
      assets: assets.length,
      network_km: Math.round(totalLenM / 100) / 10,
      outfalls: assets.filter(a => a.is_outfall).length,
      connected_properties: properties.length,
      sentinel_devices: devCount.rows[0].n,
      attention: assets.filter(a => a.needs_attention).length,
    };

    res.json({ success: true, data: { assets, properties, water_bodies, zones, summary } });
  } catch (err) {
    console.error('GET /network/graph', err);
    res.status(500).json({ success: false, error: 'Failed to load network graph' });
  }
});

// GET /network/asset/:id/maintenance — inline history for the inspector drawer.
router.get('/asset/:id/maintenance', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT event_type, description, occurred_at
         FROM property_events
        WHERE property_id = $1 AND event_type IN ('silt_clearing','maintenance','node_repair','inspection','flood_incident','report_delivered')
        ORDER BY occurred_at DESC LIMIT 12`, [req.params.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /network/asset/:id/maintenance', err);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

module.exports = router;
