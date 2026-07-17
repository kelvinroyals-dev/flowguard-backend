// Analytics — KPIs + map data for ops dashboard
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { scoreProperties } = require('../utils/riskForecast');
const router = express.Router();

// Company-wide revenue/MRR and every client's map location — ops only.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

// GET /analytics/kpis
router.get('/kpis', authenticateToken, async (req, res) => {
  try {
    const q = async (sql, p=[]) => (await pool.query(sql, p)).rows[0];
    const activeSites   = await q(`SELECT COUNT(*) n FROM clients`);
    const mrr           = await q(`SELECT COALESCE(SUM(mrr),0) v FROM clients`);
    const coverage      = await q(`SELECT COALESCE(SUM(coverage_km),0) v FROM clients`);
    // "online" requires BOTH an active status AND telemetry within the last 6h —
    // status alone is set once at registration and the ingestion pipeline never
    // touches it, so a node silent for weeks would otherwise still read "online".
    const sensors       = await q(`SELECT COUNT(*) total,
                                          COUNT(*) FILTER (WHERE status='active' AND last_ping > NOW() - INTERVAL '6 hours') online
                                     FROM sensors`);
    // severity is critical | high | moderate | minor (alerts.severity CHECK
    // constraint) — the dashboard shows both critical and high counts, so
    // both need to be queried; a missing 'high' silently renders as 0.
    const alerts        = await q(`SELECT COUNT(*) FILTER (WHERE status='active') active,
                                          COUNT(*) FILTER (WHERE status='active' AND severity='critical') critical,
                                          COUNT(*) FILTER (WHERE status='active' AND severity='high') high FROM alerts`);
    const pendingInsp   = await q(`SELECT COUNT(*) n FROM inspections WHERE status='pending'`);
    // Assets are drainage assets (asset_class='drainage_asset'), NOT customer
    // properties — those are two different rows in the same table. "monitored"
    // means it has at least one Sentinel covering it via sentinel_coverage.
    const assets         = await q(`
      SELECT COUNT(*) total,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sentinel_coverage sc WHERE sc.property_id = properties.property_id
             )) monitored
        FROM properties WHERE asset_class = 'drainage_asset'`);
    const total = parseInt(sensors.total)||0, online = parseInt(sensors.online)||0;
    res.json({ success: true, data: {
      activeSites:        parseInt(activeSites.n)||0,
      mrr:                parseFloat(mrr.v)||0,
      coverage:           parseFloat(coverage.v)||0,
      activeAlerts:       parseInt(alerts.active)||0,
      criticalAlerts:     parseInt(alerts.critical)||0,
      highAlerts:         parseInt(alerts.high)||0,
      pendingInspections: parseInt(pendingInsp.n)||0,
      sensorsOnline:      { online, total },
      networkUptime:      total ? +((online/total)*100).toFixed(1) : 0,
      assetsMonitored:    { total: parseInt(assets.total)||0, monitored: parseInt(assets.monitored)||0 },
    }});
  } catch (err) {
    console.error('GET /analytics/kpis', err);
    res.status(500).json({ success: false, error: 'Failed to load KPIs' });
  }
});

// GET /analytics/map-data  -> { sites:[client points], sensors:[device points], areas:[properties], alerts:[] }
router.get('/map-data', authenticateToken, async (req, res) => {
  try {
    // Sites = client accounts (their HQ/coverage-circle pin), NOT sensor devices.
    // This used to be returned under the key "sensors", which meant the map's
    // "Sensors" layer was actually plotting client sites (5-6 points) while the
    // KPI strip and Sentinel page counted real sensor devices (dozens+) — two
    // different entities reported under the same label. Also, the frontend has
    // always expected a separate `sites` array (plotSites/fitBounds already read
    // md.sites) — the backend just never sent it, so that layer silently rendered
    // empty on every load.
    const sites = await pool.query(`
      SELECT c.id, c.name, c.tier, c.location, c.latitude, c.longitude, c.coverage_km, c.mrr,
             'active' AS status,
             COUNT(DISTINCT s.id) AS sensor_count,
             COUNT(DISTINCT s.id) FILTER (WHERE s.status='active' AND s.last_ping > NOW() - INTERVAL '6 hours') AS sensors_online,
             COUNT(DISTINCT a.id) FILTER (WHERE a.status='active') AS active_alerts
      FROM clients c
      LEFT JOIN sensors s ON s.client_id=c.id
      LEFT JOIN alerts a ON a.client_id=c.id
      WHERE c.latitude IS NOT NULL
      GROUP BY c.id`);
    // Sensors = the actual devices, each with its own coordinates.
    const sensors = await pool.query(`
      SELECT s.sensor_id, s.name, s.zone, s.status, s.last_ping, s.latitude, s.longitude,
             c.name AS site_name
        FROM sensors s
        LEFT JOIN clients c ON c.id = s.client_id
       WHERE s.latitude IS NOT NULL`);
    const areas = await pool.query(`
      SELECT property_id, property_name, property_type, city, state, status,
             urgency_level, latitude, longitude
      FROM properties WHERE latitude IS NOT NULL`);
    const alerts = await pool.query(`
      SELECT a.alert_id, a.severity, a.status, a.alert_type, s.latitude, s.longitude, c.name AS client_name
      FROM alerts a LEFT JOIN sensors s ON a.sensor_id=s.sensor_id
      LEFT JOIN clients c ON a.client_id=c.id
      WHERE a.status='active' AND s.latitude IS NOT NULL`);

    // Flood risk zones for the map layer — this used to be requested by the
    // frontend (plotFloodRisk(md.flood_risk)) but never sent by the backend,
    // so the layer silently rendered empty on every load. Reuses the same
    // current-risk formula as the client portal and the AI Risk Forecast
    // screen (utils/riskForecast.js) — one risk number, three consumers.
    let floodRisk = [];
    try {
      const estates = await scoreProperties();
      floodRisk = estates
        .filter(e => e.latitude != null && e.longitude != null)
        .map(e => ({
          property_id: e.property_id, name: e.name,
          latitude: e.latitude, longitude: e.longitude,
          risk_index: e.current_risk,
          flood_risk_level: e.current_risk >= 70 ? 'critical' : e.current_risk >= 50 ? 'high' : e.current_risk >= 30 ? 'moderate' : 'low',
        }));
    } catch (err) {
      console.error('GET /analytics/map-data flood_risk', err.message);
    }

    res.json({ success: true, data: {
      sites:      sites.rows,
      sensors:    sensors.rows,
      areas:      areas.rows,
      alerts:     alerts.rows,
      flood_risk: floodRisk,
    }});
  } catch (err) {
    console.error('GET /analytics/map-data', err);
    res.status(500).json({ success: false, error: 'Failed to load map data' });
  }
});

module.exports = router;
