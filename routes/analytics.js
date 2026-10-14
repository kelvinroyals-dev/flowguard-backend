// Analytics — KPIs + map data for ops dashboard
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isClient, isSpUser } = require('../utils/scope');
const { scoreProperties } = require('../utils/riskForecast');
const { computeInterventionEffects } = require('../utils/interventions');
const { riskLevel } = require('../utils/riskPresentation');
const router = express.Router();

// Company-wide revenue/MRR and every client's map location — ops only.
router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req) || isSpUser(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
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
router.get('/estate-situation', async(req,res)=>{
 res.set('Cache-Control','private, no-store');
 try{
  if(!require('../utils/roles').INTERNAL_ROLES.includes(req.user.role)||!await require('../utils/permissions').hasPermission(req.user.role,'situation.view'))return res.status(403).json({success:false,error:'Not authorised'});
  let scope;try{scope=require('../utils/geography').scope(req.query);}catch(_){return res.status(400).json({success:false,error:'Invalid geography filter'});}
  const hz=await require('../utils/riskForecast').buildHorizonForecast(scope),ids=hz.estates.map(e=>e.property_id);
  const {rows:alerts}=await pool.query(`SELECT a.*,p.property_id,p.property_name,p.property_name AS site_name,COALESCE(ss.latitude,p.latitude) AS latitude,COALESCE(ss.longitude,p.longitude) AS longitude,ft.team_name AS assigned_team FROM alerts a LEFT JOIN sensors ss ON ss.sensor_id=a.sensor_id LEFT JOIN properties sp ON sp.property_id=ss.property_id LEFT JOIN properties ap ON ap.property_id=a.property_id LEFT JOIN properties p ON p.property_id=COALESCE(ap.parent_property_id,ap.property_id,sp.parent_property_id,sp.property_id) LEFT JOIN field_teams ft ON ft.team_id::text=a.assigned_team_id::text WHERE p.property_id=ANY($1::text[]) ORDER BY a.created_at DESC`,[ids]);
  const {rows:sensors}=await pool.query(`SELECT s.* FROM sensors s JOIN properties p ON p.property_id=s.property_id WHERE COALESCE(p.parent_property_id,p.property_id)=ANY($1::text[]) OR s.sensor_id IN (SELECT sensor_id FROM sentinel_coverage WHERE property_id=ANY($1::text[]))`,[ids]);
  const {rows:teams}=await pool.query('SELECT * FROM field_teams WHERE team_id::text=ANY($1::text[])',[alerts.filter(a=>!['resolved','closed','dismissed','cancelled'].includes(a.status)).map(a=>a.assigned_team_id).filter(v=>v!=null).map(String)]);
  const {rows:ticks}=await pool.query('SELECT * FROM tickets WHERE property_id=ANY($1::text[]) ORDER BY created_at DESC',[ids]);
  res.json({success:true,data:{hz,md:{areas:hz.estates,flood_risk:hz.estates,sensors,alerts,sites:[]},alerts,teams,ticks,geography:scope,team_scope:'Teams assigned to returned estate incidents; not national availability',unlinked_scope:'Records without an estate link are excluded from geographic views'}});
 }catch(_){res.status(503).json({success:false,error:'Scoped situation unavailable'});}
});
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
             'unknown' AS status,
             COUNT(DISTINCT s.sensor_id) AS sensor_count,
             COUNT(DISTINCT s.sensor_id) FILTER (WHERE s.status='active' AND s.last_ping > NOW() - INTERVAL '6 hours' AND s.last_ping<=NOW()) AS sensors_online,
             COUNT(DISTINCT a.alert_id) FILTER (WHERE a.status='active') AS active_alerts
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
             urgency_level, latitude, longitude, asset_class
      FROM properties WHERE latitude IS NOT NULL AND (asset_class='customer_property' OR asset_class IS NULL)`);
    const alerts = await pool.query(`
      SELECT a.alert_id, a.severity, a.status, a.alert_type,
        CASE WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.latitude ELSE p.latitude END AS latitude,
        CASE WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.longitude ELSE p.longitude END AS longitude,
        CASE WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN 'device' ELSE 'recorded_property' END AS location_source,
        c.name AS client_name
      FROM alerts a LEFT JOIN sensors s ON a.sensor_id=s.sensor_id
      LEFT JOIN properties p ON p.property_id=a.property_id
      LEFT JOIN clients c ON a.client_id=c.id
      WHERE a.status='active' AND COALESCE(s.latitude,p.latitude) IS NOT NULL`);

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
          risk_index: e.has_live ? e.current_risk : null,
          baseline_estimate:e.has_live ? null : e.current_risk,
          latest_reading:e.latest_reading,assessment_basis:e.assessment_basis,telemetry_state:e.telemetry_state,
          flood_risk_level: riskLevel(e.current_risk,e.has_live),
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
      generated_at:new Date().toISOString(),
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
const STALE_MS = 30 * 60 * 1000, OFFLINE_MS = 6 * 60 * 60 * 1000;

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
    const offline = s.status !== 'active' || !Number.isFinite(pingAge) || pingAge<0 || pingAge > OFFLINE_MS;
    if (offline) out.offline++; else out.online++;
    const rAge = s.reading_time ? now - new Date(s.reading_time).getTime() : Infinity;
    const wl = s.wl == null ? null : parseFloat(s.wl);
    if (!Number.isFinite(rAge) || rAge<0 || wl == null || !Number.isFinite(wl) || wl < 0 || wl > 100) out.invalid++;
    else if (rAge > STALE_MS) out.stale++;
    else out.valid++;
  }
  return out;
}

router.get('/overview', authenticateToken, async (req, res) => {
  const vm = { live: true,generated_at:new Date().toISOString() };
  const failed=[];
  // ── estates + risk ──────────────────────────────────────────────────────
  let estates = [];
  try { estates = await scoreProperties(); } catch (e) { failed.push('estate risk');console.error('overview scoreProperties', e.message); }
  // estate location (zone/city) for the row subtitle — operational, not owner name
  let loc = {};
  try {
    const l = await pool.query(`SELECT property_id, COALESCE(NULLIF(zone,''), city) AS loc FROM properties`);
    l.rows.forEach(r => { loc[r.property_id] = r.loc || ''; });
  } catch (_) {failed.push('estate locations');}
  const withLevel = estates.map(e => {
    const hasLive = (e.sensor_count || 0) > 0 && e.has_live && riskLevel(e.current_risk)!=='unknown';   // eligible sensor-backed assessment
    const score = riskLevel(e.current_risk,hasLive)==='unknown'?null:Math.round(Number(e.current_risk));
    return { ...e, score, hasLive, location: loc[e.property_id] || '', risk: hasLive ? riskLevel(score, true) : 'unknown' };
  });
  const rk = { critical: 0, high: 0, elevated: 0, moderate: 0, low: 0, unknown: 0 };
  withLevel.forEach(e => { rk[e.risk] = (rk[e.risk] || 0) + 1; });
  rk.highRisk = rk.critical + rk.high;

  // ── Change · 1h — snapshot live-assessed scores (≤hourly) and diff vs ~1h ago
  const changeById = {};
  const liveIds = withLevel.filter(e => e.hasLive).map(e => e.property_id);
  if (liveIds.length) {
    try {
      // Read-only: opening a dashboard never fabricates a historical snapshot.
      const past = await pool.query(
        `SELECT DISTINCT ON (property_id) property_id, score
           FROM estate_risk_snapshots
          WHERE property_id = ANY($1) AND captured_at <= NOW() - INTERVAL '40 minutes'
            AND captured_at >= NOW() - INTERVAL '80 minutes'
          ORDER BY property_id, captured_at DESC`, [liveIds]);
      past.rows.forEach(r => {
        const cur = withLevel.find(e => e.property_id === r.property_id);
        if (cur) changeById[r.property_id] = cur.score - r.score;
      });
    } catch (err) { console.error('overview snapshots', err.message); }
  }

  // active jobs per property (for response status)
  let activeJobProps = new Set();
  try {
    const j = await pool.query(`SELECT DISTINCT property_id FROM jobs WHERE status IN ('dispatched','accepted','en_route','in_progress')`);
    activeJobProps = new Set(j.rows.map(r => r.property_id));
  } catch (_) {failed.push('work orders');}

  const respFor = (e) => {
    if (activeJobProps.has(e.property_id)) return 'Open work order';
    if ((e.open_incidents || 0) > 0) return 'Unassigned';
    if (e.health_score != null && e.health_score < 60) return 'Inspection due';
    return 'Monitoring';
  };
  const topEstates = [...withLevel].sort((a, b) => b.score - a.score).map(e => ({
    property_id: e.property_id,
    name: e.name || e.property_id,
    zone: e.location,
    score: e.hasLive ? e.score : null,           // no definitive score without live telemetry
    baseline: e.hasLive ? null : e.score,        // baseline estimate, shown distinctly
    risk: e.risk,
    change: (e.hasLive && changeById[e.property_id] != null) ? changeById[e.property_id] : null,  // real 1h delta or null
    driver: e.hasLive
      ? 'Recent telemetry-based risk estimate'
      : 'No live assessment',
    response: respFor(e),
  }));

  vm.risk = rk;
  vm.estates = topEstates;
  vm.portfolio = {
    estates: withLevel.length,
    assessed: withLevel.filter(e => e.hasLive).length,      // sensor-backed assessments
    unknown: withLevel.filter(e => !e.hasLive).length,      // baseline / unassessed
  };

  // ── device trust ────────────────────────────────────────────────────────
  try {
    const t = await deviceTrust();
    vm.portfolio.online = t.online; vm.portfolio.offline = t.offline; vm.portfolio.total = t.total;
    vm.confidence = { pct: t.total ? Math.round(t.valid / t.total * 100) : null, valid: t.valid, stale: t.stale, invalid: t.invalid, total: t.total, needReview: t.stale + t.invalid };
  } catch (e) {
    console.error('overview deviceTrust', e.message);
    failed.push('device trust');
    vm.portfolio.online = 0; vm.portfolio.offline = 0; vm.portfolio.total = 0;
    vm.confidence = { pct: 0, valid: 0, stale: 0, invalid: 0, total: 0, needReview: 0 };
  }

  // ── a real "risk unavailable" node (online but no fresh reading) ─────────
  vm.lagoon = null;
  try {
    const d = await pool.query(`
      SELECT s.sensor_id, p.property_name, s.name,
             lr.time AS reading_time
        FROM sensors s
        LEFT JOIN properties p ON p.property_id=s.property_id
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
  const rd = { open: 0, unacknowledged: 0, priority: [], workOrders: 0, teamsDeployed: '0 / 0', teamsConfigured: false, slaBreaches: 0, nextAction: 'No incident response required', dispatchable: false };
  try {
    const a = await pool.query(`
      SELECT a.alert_id,a.alert_type, a.severity, a.status, a.assigned_team_id, a.created_at,
             s.name AS sensor_name, a.description, p.property_name
        FROM alerts a LEFT JOIN properties p ON p.property_id = a.property_id
        LEFT JOIN sensors s ON s.sensor_id=a.sensor_id
       WHERE a.status = 'active'
       ORDER BY (CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END), a.created_at DESC`);
    rd.open = a.rows.length;
    rd.unacknowledged = a.rows.filter(r => !r.assigned_team_id).length;
    rd.priority = a.rows.slice(0, 2).map(r => ({
      alert_id:r.alert_id,
      estate: r.property_name || r.asset_name || r.sensor_name || 'Incident',
      issue: r.alert_type ? String(r.alert_type).replace(/_/g, ' ') : (r.description || 'Alert'),
      ago: r.created_at ? Math.max(1, Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000)) + ' min ago' : '',
      acked: !!r.assigned_team_id,
      state: r.assigned_team_id ? null : 'Unassigned',
      team: r.assigned_team_id ? 'Assigned' : null,
    }));
    const firstUnassigned = a.rows.find(r => !r.assigned_team_id);
    if (firstUnassigned) {
      rd.dispatchable = true;
      rd.dispatchTarget = firstUnassigned.property_name || firstUnassigned.asset_name || 'incident';
      rd.nextAction = `Dispatch a team to ${rd.dispatchTarget}`;
    }
  } catch (e) { failed.push('incidents');console.error('overview alerts', e.message); }
  try {
    const t = await pool.query(`SELECT status FROM field_teams`);
    const total = t.rows.length;
    const deployed = t.rows.filter(r => ['on_site', 'en_route'].includes(r.status)).length;
    rd.teamsConfigured = total > 0;
    rd.teamsDeployed = total > 0 ? `${deployed} / ${total}` : 'No teams configured';
  } catch (_) {failed.push('teams');}
  try {
    const j = await pool.query(`SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('dispatched','accepted','en_route','in_progress')`);
    rd.workOrders = j.rows[0] ? j.rows[0].n : 0;
  } catch (_) {failed.push('work order counts');}
  try {
    const s = await pool.query(`SELECT COALESCE(SUM(jsonb_array_length(COALESCE(sla_breaches,'[]'::jsonb))),0)::int AS n
      FROM sla_tracking WHERE month>=date_trunc('month',CURRENT_DATE)
      AND month<date_trunc('month',CURRENT_DATE)+INTERVAL '1 month'`);
    rd.slaBreaches = s.rows[0] ? s.rows[0].n : 0;
  } catch (_) { failed.push('service performance'); }
  vm.response = rd;

  // ── drainage (last 24h) ─────────────────────────────────────────────────
  vm.drainage = { peak: null, restricted: 0, rising: 0, series: [],observations:0 };
  try {
    const p = await pool.query(`SELECT ROUND(MAX(water_level_percent))::int AS peak,
             COUNT(DISTINCT sensor_id) FILTER (WHERE water_level_percent >= 90) AS restr,COUNT(*)::int AS observations
        FROM sensor_readings WHERE time > NOW() - INTERVAL '24 hours' AND time<=NOW() AND water_level_percent BETWEEN 0 AND 100`);
    if (p.rows[0]) { vm.drainage.peak = p.rows[0].peak; vm.drainage.restricted = parseInt(p.rows[0].restr) || 0;vm.drainage.observations=p.rows[0].observations; }
    const riseQ = await pool.query(`
      SELECT COUNT(DISTINCT sensor_id) AS n FROM sensor_readings
       WHERE time > NOW() - INTERVAL '2 hours' AND time<=NOW() AND water_level_percent BETWEEN 70 AND 100`);
    vm.drainage.rising = riseQ.rows[0] ? parseInt(riseQ.rows[0].n) : 0;
    const ser = await pool.query(`
      SELECT ROUND(AVG(water_level_percent))::int AS v
        FROM sensor_readings WHERE time > NOW() - INTERVAL '24 hours' AND time<=NOW() AND water_level_percent BETWEEN 0 AND 100
       GROUP BY date_trunc('hour', time) ORDER BY date_trunc('hour', time)`);
    vm.drainage.series = ser.rows.map(r => r.v).filter(v => v != null);
  } catch (e) { failed.push('drainage observations');console.error('overview drainage', e.message); }

  // Estate weather coverage. Millimetres are never summed across estates.
  const weatherService=require('../utils/estateWeather');
  const snapshots=await weatherService.forEstates(estates);
  const estimates=estates.map(e=>{const w=snapshots.get(String(e.property_id));return w?{property_id:e.property_id,name:e.name,next6:w.next6,series:w.forecast.slice(0,6).map(h=>h.v),fetched_at:w.fetchedAt}:null;});
  const supplied=estimates.filter(w=>w&&w.next6!=null).sort((a,b)=>b.next6-a.next6),reference=supplied[0];
  vm.weather={rainfall:reference?.next6??null,exposed:null,updated:reference?.fetched_at??null,series:reference?.series||[],available:supplied.length>0,scope:'estate',reference:reference?{property_id:reference.property_id,name:reference.name}:null,coverage:{available:supplied.length,total:estates.length,unavailable:estates.length-supplied.length}};
  if (failed.length) return res.status(503).json({success:false,error:'Portfolio source feeds unavailable',unavailable:failed});
  res.json({ success: true, data: vm });
});

module.exports = router;
