// Analytics — KPIs + map data for ops dashboard
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { scoreProperties } = require('../utils/riskForecast');
const { computeInterventionEffects } = require('../utils/interventions');
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

// GET /analytics/interventions?days=180&window=7 — does maintenance reduce risk?
router.get('/interventions', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 180, 30), 365);
    const windowDays = Math.min(Math.max(parseInt(req.query.window, 10) || 7, 1), 30);
    const data = await computeInterventionEffects({ days, windowDays });
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /analytics/interventions', err);
    res.status(500).json({ success: false, error: 'Failed to compute intervention effects' });
  }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /analytics/overview — the live Operations Overview view model.
//  Real portfolio, device trust, estate risk, response desk, drainage, weather.
//  Every section is wrapped so a thin/empty feed degrades to zeros, never 500s.
// ════════════════════════════════════════════════════════════════════════
const STALE_MS = 30 * 60 * 1000, OFFLINE_MS = 15 * 60 * 1000;
const riskLevel = (score, hasData) => !hasData ? 'unknown'
  : score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'moderate' : 'low';

async function deviceTrust() {
  const out = { total: 0, online: 0, offline: 0, valid: 0, stale: 0, invalid: 0 };
  const { rows } = await pool.query(`
    SELECT s.sensor_id, s.status, s.last_ping,
           lr.time AS reading_time, lr.wl
      FROM sensors s
      LEFT JOIN LATERAL (
        SELECT time, water_level_percent AS wl FROM sensor_readings r
         WHERE r.sensor_id = s.sensor_id ORDER BY time DESC LIMIT 1) lr ON TRUE
     WHERE COALESCE(s.lifecycle_state,'active') NOT IN ('retired','rma')`);
  const now = Date.now();
  for (const s of rows) {
    out.total++;
    const pingAge = s.last_ping ? now - new Date(s.last_ping).getTime() : Infinity;
    const offline = s.status === 'offline' || s.status === 'maintenance' || pingAge > OFFLINE_MS;
    if (offline) out.offline++; else out.online++;
    const rAge = s.reading_time ? now - new Date(s.reading_time).getTime() : Infinity;
    const wl = s.wl == null ? null : parseFloat(s.wl);
    if (offline || rAge === Infinity || wl == null || wl < 0 || wl > 100) out.invalid++;
    else if (rAge > STALE_MS) out.stale++;
    else out.valid++;
  }
  return out;
}

router.get('/overview', authenticateToken, async (req, res) => {
  const vm = { live: true };
  // ── estates + risk ──────────────────────────────────────────────────────
  let estates = [];
  try { estates = await scoreProperties(); } catch (e) { console.error('overview scoreProperties', e.message); }
  const withLevel = estates.map(e => {
    const hasData = (e.sensor_count || 0) > 0 && e.has_live;
    const score = Math.round(e.current_risk || 0);
    return { ...e, score, risk: riskLevel(score, hasData || score > 0) };
  });
  const rk = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  withLevel.forEach(e => { rk[e.risk] = (rk[e.risk] || 0) + 1; });
  rk.highRisk = rk.critical + rk.high;

  // active jobs per property (for response status)
  let activeJobProps = new Set();
  try {
    const j = await pool.query(`SELECT DISTINCT property_id FROM jobs WHERE status IN ('dispatched','accepted','in_progress')`);
    activeJobProps = new Set(j.rows.map(r => r.property_id));
  } catch (_) {}

  const respFor = (e) => {
    if (activeJobProps.has(e.property_id)) return 'Team en route';
    if ((e.open_incidents || 0) > 0) return 'Unassigned';
    if (e.health_score != null && e.health_score < 60) return 'Inspection due';
    return 'Monitoring';
  };
  const topEstates = [...withLevel].sort((a, b) => b.score - a.score).slice(0, 8).map(e => ({
    name: e.name || e.property_id,
    zone: e.client_name || '',
    score: e.score,
    risk: e.risk,
    change: 0,
    driver: (e.env_contributors && e.env_contributors[0] && e.env_contributors[0].label) || (e.risk === 'unknown' ? 'No live telemetry' : 'Stable'),
    response: respFor(e),
  }));

  vm.risk = rk;
  vm.estates = topEstates;
  vm.portfolio = {
    estates: withLevel.length,
    assessed: withLevel.filter(e => e.risk !== 'unknown').length,
    unknown: withLevel.filter(e => e.risk === 'unknown').length,
  };

  // ── device trust ────────────────────────────────────────────────────────
  try {
    const t = await deviceTrust();
    vm.portfolio.online = t.online; vm.portfolio.offline = t.offline; vm.portfolio.total = t.total;
    const totalStreams = t.total || 1;
    vm.confidence = { pct: Math.round(t.valid / totalStreams * 100), valid: t.valid, stale: t.stale, invalid: t.invalid, total: t.total, needReview: t.stale + t.invalid };
  } catch (e) {
    console.error('overview deviceTrust', e.message);
    vm.portfolio.online = 0; vm.portfolio.offline = 0; vm.portfolio.total = 0;
    vm.confidence = { pct: 0, valid: 0, stale: 0, invalid: 0, total: 0, needReview: 0 };
  }

  // ── a real "risk unavailable" node (online but no fresh reading) ─────────
  vm.lagoon = null;
  try {
    const d = await pool.query(`
      SELECT s.sensor_id, s.property_name, s.name,
             lr.time AS reading_time
        FROM sensors s
        LEFT JOIN LATERAL (SELECT time FROM sensor_readings r WHERE r.sensor_id=s.sensor_id ORDER BY time DESC LIMIT 1) lr ON TRUE
       WHERE COALESCE(s.lifecycle_state,'active') NOT IN ('retired','rma')
         AND s.status = 'active'
         AND (lr.time IS NULL OR lr.time < NOW() - INTERVAL '30 minutes')
       ORDER BY lr.time ASC NULLS FIRST LIMIT 1`);
    if (d.rows.length) {
      const n = d.rows[0];
      vm.lagoon = { name: n.property_name || n.name || n.sensor_id, device: n.sensor_id,
        lastValid: n.reading_time ? Math.round((Date.now() - new Date(n.reading_time).getTime()) / 60000) + 'm ago' : 'never' };
    }
  } catch (_) {}

  // ── response desk ───────────────────────────────────────────────────────
  const rd = { open: 0, unacknowledged: 0, priority: [], workOrders: 0, teamsDeployed: '0 / 0', slaBreaches: 0, nextAction: 'All estates monitored' };
  try {
    const a = await pool.query(`
      SELECT a.alert_type, a.severity, a.status, a.assigned_team_id, a.created_at,
             a.asset_name, a.sensor_name, a.description, p.property_name
        FROM alerts a LEFT JOIN properties p ON p.property_id = a.property_id
       WHERE a.status = 'active'
       ORDER BY (CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END), a.created_at DESC`);
    rd.open = a.rows.length;
    rd.unacknowledged = a.rows.filter(r => !r.assigned_team_id).length;
    rd.priority = a.rows.slice(0, 2).map(r => ({
      estate: r.property_name || r.asset_name || r.sensor_name || 'Incident',
      issue: r.alert_type ? String(r.alert_type).replace(/_/g, ' ') : (r.description || 'Alert'),
      ago: r.created_at ? Math.max(1, Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000)) + ' min ago' : '',
      acked: !!r.assigned_team_id,
      state: r.assigned_team_id ? null : 'Unassigned',
      team: r.assigned_team_id ? 'Assigned' : null,
    }));
    const firstUnassigned = a.rows.find(r => !r.assigned_team_id);
    if (firstUnassigned) rd.nextAction = `Dispatch a team to ${firstUnassigned.property_name || firstUnassigned.asset_name || 'incident'}`;
  } catch (e) { console.error('overview alerts', e.message); }
  try {
    const t = await pool.query(`SELECT status FROM teams`);
    const total = t.rows.length;
    const deployed = t.rows.filter(r => ['on_site', 'en_route'].includes(r.status)).length;
    rd.teamsDeployed = `${deployed} / ${total}`;
  } catch (_) {}
  try {
    const j = await pool.query(`SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('dispatched','accepted','in_progress')`);
    rd.workOrders = j.rows[0] ? j.rows[0].n : 0;
  } catch (_) {}
  try {
    const s = await pool.query(`SELECT COUNT(*)::int AS n FROM sla_breaches WHERE breached_at::date = NOW()::date`);
    rd.slaBreaches = s.rows[0] ? s.rows[0].n : 0;
  } catch (_) { rd.slaBreaches = 0; }
  vm.response = rd;

  // ── drainage (last 24h) ─────────────────────────────────────────────────
  vm.drainage = { peak: 0, restricted: 0, rising: 0, series: [] };
  try {
    const p = await pool.query(`SELECT ROUND(MAX(water_level_percent))::int AS peak,
             COUNT(*) FILTER (WHERE water_level_percent >= 90) AS restr
        FROM sensor_readings WHERE time > NOW() - INTERVAL '24 hours'`);
    if (p.rows[0]) { vm.drainage.peak = p.rows[0].peak || 0; vm.drainage.restricted = parseInt(p.rows[0].restr) || 0; }
    const riseQ = await pool.query(`
      SELECT COUNT(DISTINCT sensor_id) AS n FROM sensor_readings
       WHERE time > NOW() - INTERVAL '2 hours' AND water_level_percent >= 70`);
    vm.drainage.rising = riseQ.rows[0] ? parseInt(riseQ.rows[0].n) : 0;
    const ser = await pool.query(`
      SELECT ROUND(AVG(water_level_percent))::int AS v
        FROM sensor_readings WHERE time > NOW() - INTERVAL '24 hours'
       GROUP BY date_trunc('hour', time) ORDER BY date_trunc('hour', time)`);
    vm.drainage.series = ser.rows.map(r => r.v).filter(v => v != null);
  } catch (e) { console.error('overview drainage', e.message); }
  if (!vm.drainage.series.length) vm.drainage.series = [vm.drainage.peak || 0];

  // ── weather (next 6h, Open-Meteo) ───────────────────────────────────────
  vm.weather = { rainfall: 0, exposed: rk.highRisk, updated: null, series: [] };
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=6.45&longitude=3.4&hourly=precipitation&timezone=Africa%2FLagos&forecast_hours=6');
    if (r.ok) {
      const j = await r.json();
      const pr = (j.hourly && j.hourly.precipitation) || [];
      vm.weather.rainfall = Math.round(pr.reduce((s, v) => s + v, 0) * 10) / 10;
      vm.weather.series = pr;
      vm.weather.updated = new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' }) + ' WAT';
    }
  } catch (_) {}
  if (!vm.weather.series.length) vm.weather.series = [0];

  res.json({ success: true, data: vm });
});

module.exports = router;
