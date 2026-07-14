// Analytics — KPIs + map data for ops dashboard
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
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
    const sensors       = await q(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='active') online FROM sensors`);
    const alerts        = await q(`SELECT COUNT(*) FILTER (WHERE status='active') active,
                                          COUNT(*) FILTER (WHERE status='active' AND severity='critical') critical FROM alerts`);
    const pendingInsp   = await q(`SELECT COUNT(*) n FROM inspections WHERE status='pending'`);
    const total = parseInt(sensors.total)||0, online = parseInt(sensors.online)||0;
    res.json({ success: true, data: {
      activeSites:        parseInt(activeSites.n)||0,
      mrr:                parseFloat(mrr.v)||0,
      coverage:           parseFloat(coverage.v)||0,
      activeAlerts:       parseInt(alerts.active)||0,
      criticalAlerts:     parseInt(alerts.critical)||0,
      pendingInspections: parseInt(pendingInsp.n)||0,
      sensorsOnline:      { online, total },
      networkUptime:      total ? +((online/total)*100).toFixed(1) : 0,
    }});
  } catch (err) {
    console.error('GET /analytics/kpis', err);
    res.status(500).json({ success: false, error: 'Failed to load KPIs' });
  }
});

// GET /analytics/map-data  -> { sensors:[client points], areas:[properties], alerts:[] }
router.get('/map-data', authenticateToken, async (req, res) => {
  try {
    const clients = await pool.query(`
      SELECT c.id, c.name, c.tier, c.location, c.latitude, c.longitude, c.coverage_km, c.mrr,
             'active' AS status,
             COUNT(DISTINCT s.id) AS sensor_count,
             COUNT(DISTINCT s.id) FILTER (WHERE s.status='active') AS sensors_online,
             COUNT(DISTINCT a.id) FILTER (WHERE a.status='active') AS active_alerts
      FROM clients c
      LEFT JOIN sensors s ON s.client_id=c.id
      LEFT JOIN alerts a ON a.client_id=c.id
      WHERE c.latitude IS NOT NULL
      GROUP BY c.id`);
    const areas = await pool.query(`
      SELECT property_id, property_name, property_type, city, state, status,
             urgency_level, latitude, longitude
      FROM properties WHERE latitude IS NOT NULL`);
    const alerts = await pool.query(`
      SELECT a.alert_id, a.severity, a.status, a.alert_type, s.latitude, s.longitude, c.name AS client_name
      FROM alerts a LEFT JOIN sensors s ON a.sensor_id=s.sensor_id
      LEFT JOIN clients c ON a.client_id=c.id
      WHERE a.status='active' AND s.latitude IS NOT NULL`);
    res.json({ success: true, data: {
      sensors: clients.rows,   // client sites (frontend calls them sensors on the map)
      areas:   areas.rows,
      alerts:  alerts.rows,
    }});
  } catch (err) {
    console.error('GET /analytics/map-data', err);
    res.status(500).json({ success: false, error: 'Failed to load map data' });
  }
});

module.exports = router;
