// Client-portal monitoring: flood-risk index + live sensor readings
// Honest by design: returns has_data:false when no real readings exist yet,
// so the UI can show an "awaiting sensor data" state rather than a fake number.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { isClient, isSpUser, deviceSensorScope, sensorInScope } = require('../utils/scope');
const { getDriver, normalizeReading, driverSupportsCommand } = require('../utils/deviceDrivers');
const router = express.Router();

// ── Multi-tenant device isolation ─────────────────────────────────────────
// Any device route carrying a :sensorId is guarded here: a service-provider
// user may only touch sensors on the properties assigned to their org. Full-
// fleet (FlowGuard) users pass through. Runs before the route handler, so it
// covers reads and writes alike without editing each handler.
router.param('sensorId', async (req, res, next, sensorId) => {
  try {
    if (isSpUser(req) && !(await sensorInScope(req, sensorId))) {
      return res.status(403).json({ success: false, error: 'Device is outside your tenancy' });
    }
    next();
  } catch (err) {
    console.error('sensorId scope guard', err);
    res.status(500).json({ success: false, error: 'Scope check failed' });
  }
});

// Block a service-provider user from a fleet-wide (ops-only) action.
function denyTenant(req, res) {
  if (isSpUser(req)) { res.status(403).json({ success: false, error: 'Fleet-wide actions are restricted to FlowGuard operations' }); return true; }
  return false;
}

// Resolve which client(s) this user owns (client-portal users map to a client)
async function clientIdsForUser(userId) {
  // properties.user_id -> properties belong to a user; sensors attach via client_id.
  // For the client portal we surface sensors linked to the user's client record(s).
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id
       FROM clients c
       JOIN users u ON u.email = c.estate_manager_email
      WHERE u.id = $1`, [userId]);
  return rows.map(r => r.id);
}

// A client's sensors are the ones INSTALLED ON one of their own properties.
// Scoping by sensors.client_id alone surfaced devices in the client portal that
// aren't attached to any of their properties (ops, which scopes by property,
// correctly showed none) — so a property still at "submitted" appeared to have
// live nodes. This is the single source of truth for "this client's sensors".
async function clientSensorIds(userId) {
  const { propertyIdsForUser } = require('../utils/scope');
  const pids = await propertyIdsForUser(userId);
  if (!pids.length) return [];
  const { rows } = await pool.query(
    `SELECT s.sensor_id
       FROM sensors s
       JOIN properties pp ON pp.property_id = s.property_id
      WHERE COALESCE(pp.parent_property_id, pp.property_id) = ANY($1)`, [pids]);
  return rows.map(r => r.sensor_id);
}

// GET /monitoring/flood-risk  -> { has_data, risk_index, level, sensors_online, sensors_total, peak_level }
router.get('/flood-risk', authenticateToken, async (req, res) => {
  try {
    const sids = await clientSensorIds(req.user.id);
    if (!sids.length) {
      return res.json({ success: true, data: { has_data: false, reason: 'no_sensors', sensors_total: 0, sensors_online: 0 } });
    }

    // "online" = active status AND telemetry within the last 6h, not status
    // alone — status is set once at registration and never updated by ingestion.
    const sensorCount = await pool.query(
      `SELECT COUNT(*) total,
              COUNT(*) FILTER (WHERE status='active' AND last_ping > NOW() - INTERVAL '6 hours') online
         FROM sensors WHERE sensor_id = ANY($1)`, [sids]);
    const total = parseInt(sensorCount.rows[0].total) || 0;
    const online = parseInt(sensorCount.rows[0].online) || 0;

    // Latest reading per sensor in the last 6 hours
    const latest = await pool.query(
      `SELECT DISTINCT ON (r.sensor_id) r.sensor_id, r.water_level_percent, r.time
         FROM sensor_readings r
        WHERE r.sensor_id = ANY($1) AND r.time > NOW() - INTERVAL '6 hours'
        ORDER BY r.sensor_id, r.time DESC`, [sids]);

    if (!latest.rows.length) {
      // Sensors may exist but none have reported yet — be honest
      return res.json({ success: true, data: {
        has_data: false, reason: total ? 'awaiting_readings' : 'no_sensors',
        sensors_total: total, sensors_online: online
      }});
    }

    const levels = latest.rows.map(r => parseFloat(r.water_level_percent) || 0);
    const peak = Math.max(...levels);
    const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
    // Risk index: weighted toward the peak (a single full channel is what floods)
    const riskIndex = Math.round(Math.min(100, peak * 0.7 + avg * 0.3));
    const level = riskIndex >= 70 ? 'high' : riskIndex >= 45 ? 'moderate' : 'low';

    res.json({ success: true, data: {
      has_data: true, risk_index: riskIndex, level,
      peak_level: Math.round(peak), avg_level: Math.round(avg),
      sensors_online: online, sensors_total: total,
      reading_count: latest.rows.length
    }});
  } catch (err) {
    console.error('GET /monitoring/flood-risk', err);
    res.status(500).json({ success: false, error: 'Failed to compute flood risk' });
  }
});

// GET /monitoring/sensors -> [{ sensor_id, name, zone, status, level, trend[] }]
router.get('/sensors', authenticateToken, async (req, res) => {
  try {
    const sids = await clientSensorIds(req.user.id);
    if (!sids.length) return res.json({ success: true, data: [] });

    const sensors = await pool.query(
      `SELECT s.sensor_id, s.name, s.zone, s.status, s.device_variant,
              s.battery_voltage, s.signal_strength, s.last_ping,
              COALESCE(pp.parent_property_id, pp.property_id) AS property_id,
              s.enzyme_level_percent, s.cartridge_status, s.enzyme_capacity_ml,
              s.enzyme_installed_date, s.estimated_depletion_date, s.daily_dispense_ml
         FROM sensors s
         LEFT JOIN properties pp ON pp.property_id = s.property_id
        WHERE s.sensor_id = ANY($1) ORDER BY s.name`, [sids]);

    // Attach the latest reading + a small trend (last 7 readings) per sensor
    const out = [];
    for (const s of sensors.rows) {
      const readings = await pool.query(
        `SELECT water_level_percent, inflow_rate, outflow_rate, debris_detected, time
           FROM sensor_readings WHERE sensor_id = $1 ORDER BY time DESC LIMIT 7`, [s.sensor_id]);
      const trend = readings.rows.map(r => parseFloat(r.water_level_percent) || 0).reverse();
      const latest = readings.rows[0];

      const isBio = s.device_variant === 'bio_dispenser';
      let enzyme = null;
      if (isBio) {
        // days until depletion (from estimate, else from level + daily rate)
        let daysLeft = null;
        if (s.estimated_depletion_date) {
          daysLeft = Math.ceil((new Date(s.estimated_depletion_date) - Date.now()) / 86400000);
        } else if (s.enzyme_level_percent != null && s.daily_dispense_ml && s.enzyme_capacity_ml) {
          const mlLeft = (parseFloat(s.enzyme_level_percent) / 100) * s.enzyme_capacity_ml;
          daysLeft = Math.floor(mlLeft / parseFloat(s.daily_dispense_ml));
        }
        // derive status if not explicitly set
        let cstatus = s.cartridge_status;
        const lvl = s.enzyme_level_percent != null ? parseFloat(s.enzyme_level_percent) : null;
        if (!cstatus && lvl != null) {
          cstatus = lvl <= 0 ? 'depleted' : lvl < 15 ? 'due_replacement' : lvl < 30 ? 'low' : 'dispensing';
        }
        enzyme = {
          level_percent: lvl,
          status: cstatus || 'loaded',
          capacity_ml: s.enzyme_capacity_ml,
          installed_date: s.enzyme_installed_date,
          depletion_date: s.estimated_depletion_date,
          days_left: daysLeft
        };
      }

      out.push({
        sensor_id: s.sensor_id, name: s.name, zone: s.zone, status: s.status,
        device_variant: s.device_variant || 'basic',
        property_id: s.property_id,   // top-level customer property — needed for the portal's per-property scope
        level: trend.length ? trend[trend.length - 1] : null,
        flow_rate: latest && latest.inflow_rate != null ? parseFloat(latest.inflow_rate) : null,
        silt_level: latest && latest.debris_detected ? 70 : (latest ? 20 : null),
        battery_percent: s.battery_voltage != null
          ? Math.max(0, Math.min(100, Math.round(((parseFloat(s.battery_voltage) - 3.3) / 0.9) * 100))) : null,
        signal_strength: s.signal_strength,
        last_ping: s.last_ping,
        trend, has_data: trend.length > 0,
        enzyme
      });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('GET /monitoring/sensors', err);
    res.status(500).json({ success: false, error: 'Failed to load sensors' });
  }
});

// GET /monitoring/history?hours=24 -> time-series readings for charts + log
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const sids = await clientSensorIds(req.user.id);
    if (!sids.length) return res.json({ success: true, data: { series: [], log: [] } });
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));

    // Raw log: recent readings across the client's sensors (newest first)
    const log = await pool.query(
      `SELECT r.time, r.sensor_id, s.name AS sensor_name,
              r.water_level_percent, r.inflow_rate, r.debris_detected
         FROM sensor_readings r
         JOIN sensors s ON s.sensor_id = r.sensor_id
        WHERE r.sensor_id = ANY($1) AND r.time > NOW() - ($2 || ' hours')::interval
        ORDER BY r.time DESC
        LIMIT 200`, [sids, hours]);

    // Series: average water level per hour bucket for the trend chart
    const series = await pool.query(
      `SELECT date_trunc('hour', r.time) AS bucket,
              ROUND(AVG(r.water_level_percent)::numeric, 1) AS avg_level,
              ROUND(MAX(r.water_level_percent)::numeric, 1) AS peak_level
         FROM sensor_readings r
        WHERE r.sensor_id = ANY($1) AND r.time > NOW() - ($2 || ' hours')::interval
        GROUP BY bucket ORDER BY bucket ASC`, [sids, hours]);

    res.json({ success: true, data: {
      series: series.rows.map(r => ({ t: r.bucket, avg: parseFloat(r.avg_level), peak: parseFloat(r.peak_level) })),
      log: log.rows.map(r => ({
        time: r.time, sensor: r.sensor_name || r.sensor_id,
        level: r.water_level_percent != null ? parseFloat(r.water_level_percent) : null,
        flow: r.inflow_rate != null ? parseFloat(r.inflow_rate) : null,
        debris: !!r.debris_detected
      })),
      has_data: log.rows.length > 0
    }});
  } catch (err) {
    console.error('GET /monitoring/history', err);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

// GET /monitoring/sensor/:sensorId?hours=24 -> one sensor's detail + history
router.get('/sensor/:sensorId', authenticateToken, async (req, res) => {
  try {
    const sids = await clientSensorIds(req.user.id);
    if (!sids.includes(req.params.sensorId)) return res.status(404).json({ success: false, error: 'Sensor not found' });
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));

    const sres = await pool.query(
      `SELECT sensor_id, name, zone, status, device_variant,
              battery_voltage, signal_strength, last_ping,
              enzyme_level_percent, cartridge_status, enzyme_capacity_ml,
              enzyme_installed_date, estimated_depletion_date, daily_dispense_ml
         FROM sensors WHERE sensor_id = $1`, [req.params.sensorId]);
    if (!sres.rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
    const s = sres.rows[0];

    const series = await pool.query(
      `SELECT date_trunc('hour', time) AS bucket,
              ROUND(AVG(water_level_percent)::numeric,1) AS avg_level,
              ROUND(MAX(water_level_percent)::numeric,1) AS peak_level,
              ROUND(AVG(inflow_rate)::numeric,1) AS avg_flow
         FROM sensor_readings
        WHERE sensor_id = $1 AND time > NOW() - ($2 || ' hours')::interval
        GROUP BY bucket ORDER BY bucket ASC`, [req.params.sensorId, hours]);

    res.json({ success: true, data: {
      sensor_id: s.sensor_id, name: s.name, zone: s.zone, status: s.status,
      device_variant: s.device_variant || 'basic',
      battery_percent: s.battery_voltage != null
        ? Math.max(0, Math.min(100, Math.round(((parseFloat(s.battery_voltage) - 3.3) / 0.9) * 100))) : null,
      signal_strength: s.signal_strength, last_ping: s.last_ping,
      enzyme: s.device_variant === 'bio_dispenser' ? {
        level_percent: s.enzyme_level_percent != null ? parseFloat(s.enzyme_level_percent) : null,
        status: s.cartridge_status, depletion_date: s.estimated_depletion_date
      } : null,
      series: series.rows.map(r => ({ t: r.bucket, avg: parseFloat(r.avg_level), peak: parseFloat(r.peak_level), flow: parseFloat(r.avg_flow) })),
      hours
    }});
  } catch (err) {
    console.error('GET /monitoring/sensor/:id', err);
    res.status(500).json({ success: false, error: 'Failed to load sensor' });
  }
});


// ── Trustworthiness layer ────────────────────────────────────────────────
// Three states that are deliberately NOT the same thing:
//   DEVICE  — is the Sentinel alive? (online/degraded/offline/maintenance)
//   SENSOR  — is its data trustworthy? (ok/stale/frozen/implausible/unknown)
//   INFRA   — what's actually happening in the drain (normal…critical) OR
//             UNKNOWN when the sensor isn't trustworthy. Missing/stale/frozen
//             telemetry must NEVER be read as "the drain is fine".
const STALE_MIN = 90, OFFLINE_H = 6, FROZEN_READS = 10, FROZEN_SPAN_MIN = 120;
function computeStates(x, win) {
  const now = Date.now();
  const readAge = x.reading_time ? (now - new Date(x.reading_time).getTime()) / 60000 : null; // minutes
  const pingAge = x.last_ping ? (now - new Date(x.last_ping).getTime()) / 60000 : null;
  const lvl = x.level;

  // DEVICE
  let device_state, device_reason = null;
  if (x.status === 'maintenance') { device_state = 'maintenance'; device_reason = 'In maintenance'; }
  else if (x.status !== 'active' || pingAge == null || pingAge > OFFLINE_H * 60) {
    device_state = 'offline';
    device_reason = pingAge == null ? 'Never checked in' : `Last check-in ${Math.round(pingAge / 60)}h ago`;
  } else {
    const low = [];
    if (x.battery_percent != null && x.battery_percent < 50) low.push('low battery');
    if (x.signal_strength != null && x.signal_strength < 70) low.push('weak signal');
    device_state = low.length ? 'degraded' : 'online';
    device_reason = low.join(', ') || null;
  }

  // SENSOR (data trust)
  let sensor_state = 'ok', sensor_reason = null;
  if (device_state === 'offline' || device_state === 'maintenance') { sensor_state = 'unknown'; sensor_reason = 'device ' + device_state; }
  else if (lvl == null && readAge == null) { sensor_state = 'unknown'; sensor_reason = 'no readings received'; }
  else if (lvl != null && (lvl < 0 || lvl > 100)) { sensor_state = 'implausible'; sensor_reason = 'reading out of range'; }
  else if (readAge != null && readAge > STALE_MIN) { sensor_state = 'stale'; sensor_reason = `last reading ${Math.round(readAge)}m ago`; }
  else if (win && Number(win.n) >= FROZEN_READS && Number(win.span_min) >= FROZEN_SPAN_MIN
           && Number(win.sd) === 0 && Number(win.rng) === 0) {
    sensor_state = 'frozen'; sensor_reason = `value unchanged for ${(Number(win.span_min) / 60).toFixed(1)}h`;
  }
  const data_trust = sensor_state === 'ok';

  // INFRASTRUCTURE — only meaningful when the sensor is trustworthy
  let infrastructure_state = 'unknown', infra_reason = null;
  if (data_trust && lvl != null) {
    infrastructure_state = lvl >= 85 ? 'critical' : lvl >= 70 ? 'high' : lvl >= 50 ? 'elevated' : 'normal';
  } else {
    infra_reason = 'sensor ' + sensor_state; // e.g. "sensor stale" — NOT "normal"
  }
  return { device_state, device_reason, sensor_state, sensor_reason, infrastructure_state, infra_reason, data_trust };
}

// GET /monitoring/sensors/all — ops-wide node fleet with latest reading (ops only)
router.get('/sensors/all', authenticateToken, async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(`
      SELECT s.sensor_id, s.name, s.zone, s.status, s.battery_voltage, s.signal_strength,
             s.last_ping, s.max_capacity, s.latitude, s.longitude,
             s.client_id, s.property_id, s.device_variant, s.firmware_version,
             s.capabilities, s.link_type, s.tags, s.profile_id, s.applied_profile_version,
             pf.name AS profile_name, pf.version AS profile_version,
             s.driver_id, dd.name AS driver_name, dd.vendor AS driver_vendor, dd.native AS driver_native,
             s.lifecycle_state, s.serial_number, s.hardware_rev, s.manufacturing_batch,
             s.modem_imei, s.sim_iccid, s.install_date, s.warranty_expires_at,
             s.last_calibrated_at, s.calibration_due_at,
             s.enzyme_level_percent, s.cartridge_status,
             s.geofence_center_lat, s.geofence_center_lng, s.geofence_radius_m,
             s.geofence_state, s.geofence_distance_m,
             s.last_clock_skew_seconds, s.clock_synced_at,
             s.tamper_flagged, s.tamper_reason, s.tamper_at,
             -- CANONICAL: a Sentinel attaches to a PROPERTY (via sensors.property_id
             -- and sentinel_coverage), and the "client" is that property's OWNER
             -- (a users row) — NOT the clients-account table. The client is ONLY
             -- ever a person: resolve to the property owner, else the estate
             -- manager. NEVER fall back to c.name (the estate name reads like a
             -- property and must only appear under "Estate / account"). If no
             -- person can be resolved, client_name is NULL and the UI shows "—".
             -- The Property a Sentinel is installed on (its canonical parent):
             -- the customer_property resolved from sensors.property_id.
             cp.property_name AS property_name,
             cp.property_id   AS property_ref,
             COALESCE(owner.full_name, cu.full_name) AS client_name,
             COALESCE(owner.id, cu.id) AS client_user_id,
             c.name AS account_name,
             r.water_level_percent, r.water_level_liters, r.inflow_rate, r.outflow_rate,
             r.temperature, r.debris_detected, r.silt_depth_mm, r.rainfall_mm,
             r.water_quality_ph, r.turbidity_ntu, r.time AS reading_time,
             cov.assets, cmd.pending_commands
        FROM sensors s
        LEFT JOIN device_profiles pf ON pf.id = s.profile_id
        LEFT JOIN device_drivers dd ON dd.id = s.driver_id
        LEFT JOIN clients c  ON c.id = s.client_id
        LEFT JOIN users cu   ON LOWER(cu.email) = LOWER(c.estate_manager_email)
        LEFT JOIN properties sp ON sp.property_id = s.property_id
        LEFT JOIN properties cp ON cp.property_id = COALESCE(sp.parent_property_id, sp.property_id)
        LEFT JOIN users owner   ON owner.id = cp.user_id
        LEFT JOIN LATERAL (
          SELECT water_level_percent, water_level_liters, inflow_rate, outflow_rate,
                 temperature, debris_detected, silt_depth_mm, rainfall_mm,
                 water_quality_ph, turbidity_ntu, time
            FROM sensor_readings WHERE sensor_id = s.sensor_id
            ORDER BY time DESC LIMIT 1
        ) r ON true
        -- a Sentinel can cover several nearby assets: bring them all back
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
                   'property_id', p.property_id,
                   'name',        COALESCE(p.asset_code, p.property_name),
                   'type',        p.property_type,
                   'asset_class', p.asset_class,
                   'is_primary',  sc.is_primary
                 ) ORDER BY sc.is_primary DESC, p.property_name) AS assets
            FROM sentinel_coverage sc
            JOIN properties p ON p.property_id = sc.property_id
           WHERE sc.sensor_id = s.sensor_id
        ) cov ON true
        -- commands queued but not yet picked up on the node's next check-in
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS pending_commands
            FROM device_commands dc
           WHERE dc.sensor_id = s.sensor_id AND dc.status = 'queued'
        ) cmd ON true
        -- last-6h reading spread, to detect a frozen/stuck sensor (flat line)
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS n,
                 COALESCE(STDDEV_POP(water_level_percent), 0) AS sd,
                 COALESCE(MAX(water_level_percent) - MIN(water_level_percent), 0) AS rng,
                 COALESCE(EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) / 60, 0) AS span_min
            FROM sensor_readings
           WHERE sensor_id = s.sensor_id AND time > NOW() - INTERVAL '6 hours'
        ) win ON true
       ORDER BY
         CASE s.status WHEN 'active' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END,
         r.water_level_percent DESC NULLS LAST, s.name`);

    const data = rows.map(x => {
      const batt = x.battery_voltage != null
        ? Math.max(0, Math.min(100, Math.round(((parseFloat(x.battery_voltage) - 3.3) / (4.2 - 3.3)) * 100)))
        : null;
      const lvl = x.water_level_percent != null ? parseFloat(x.water_level_percent) : null;
      const flow = x.inflow_rate != null ? parseFloat(x.inflow_rate) : null;
      return {
        sensor_id: x.sensor_id, name: x.name, zone: x.zone, status: x.status,
        client_id: x.client_id, client_name: x.client_name,
        client_user_id: x.client_user_id, account_name: x.account_name,
        property_name: x.property_name, property_ref: x.property_ref,
        // every asset this node monitors (many-to-many), primary first
        assets: x.assets || [],
        primary_asset: (x.assets || []).find(a => a.is_primary) || null,
        device_variant: x.device_variant, firmware_version: x.firmware_version,
        capabilities: x.capabilities || {}, link_type: x.link_type,
        tags: x.tags || [],
        profile_id: x.profile_id, profile_name: x.profile_name,
        driver_id: x.driver_id, driver_name: x.driver_name, driver_vendor: x.driver_vendor, driver_native: x.driver_native,
        lifecycle_state: x.lifecycle_state,
        serial_number: x.serial_number, hardware_rev: x.hardware_rev, manufacturing_batch: x.manufacturing_batch,
        modem_imei: x.modem_imei, sim_iccid: x.sim_iccid, install_date: x.install_date, warranty_expires_at: x.warranty_expires_at,
        config_drift: x.profile_id ? (x.applied_profile_version !== x.profile_version) : false,
        config_state: !x.profile_id ? 'none' : (x.applied_profile_version == null ? 'pending' : (x.applied_profile_version !== x.profile_version ? 'drift' : 'in_sync')),
        last_calibrated_at: x.last_calibrated_at, calibration_due_at: x.calibration_due_at,
        geofence_center_lat: x.geofence_center_lat, geofence_center_lng: x.geofence_center_lng,
        geofence_radius_m: x.geofence_radius_m, geofence_state: x.geofence_state, geofence_distance_m: x.geofence_distance_m,
        last_clock_skew_seconds: x.last_clock_skew_seconds, clock_synced_at: x.clock_synced_at,
        tamper_flagged: x.tamper_flagged, tamper_reason: x.tamper_reason, tamper_at: x.tamper_at,
        ...integrityOf(x),
        enzyme_level_percent: x.enzyme_level_percent != null ? parseFloat(x.enzyme_level_percent) : null,
        cartridge_status: x.cartridge_status,
        silt_depth_mm: x.silt_depth_mm != null ? parseFloat(x.silt_depth_mm) : null,
        rainfall_mm: x.rainfall_mm != null ? parseFloat(x.rainfall_mm) : null,
        water_quality_ph: x.water_quality_ph != null ? parseFloat(x.water_quality_ph) : null,
        turbidity_ntu: x.turbidity_ntu != null ? parseFloat(x.turbidity_ntu) : null,
        level: lvl,
        level_liters: x.water_level_liters != null ? parseFloat(x.water_level_liters) : null,
        flow_rate: flow,
        outflow_rate: x.outflow_rate != null ? parseFloat(x.outflow_rate) : null,
        temperature: x.temperature != null ? parseFloat(x.temperature) : null,
        debris_detected: x.debris_detected,
        battery_percent: batt,
        battery_voltage: x.battery_voltage != null ? parseFloat(x.battery_voltage) : null,
        signal_strength: x.signal_strength,
        last_ping: x.last_ping, reading_time: x.reading_time,
        latitude: x.latitude, longitude: x.longitude,
        pending_commands: parseInt(x.pending_commands) || 0,
        ...computeStates(
          { status: x.status, last_ping: x.last_ping, reading_time: x.reading_time,
            level: lvl, battery_percent: batt, signal_strength: x.signal_strength },
          { n: x.n, sd: x.sd, rng: x.rng, span_min: x.span_min }),
      };
    });
    // multi-tenant isolation: an SP user only sees devices in their tenancy
    const scope = await deviceSensorScope(req);
    const out = scope ? (() => { const set = new Set(scope); return data.filter(d => set.has(d.sensor_id)); })() : data;
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('GET /monitoring/sensors/all', err);
    res.status(500).json({ success: false, error: 'Failed to load sensor fleet' });
  }
});


// ══════════════════════════════════════════════════════════════
//  DEVICE TELEMETRY INGESTION
//  Sentinel nodes POST here with their own device key (not a user JWT).
//    Header:  X-Device-Key: <key issued at provisioning>
//    Body:    { sensor_id, water_level_percent, water_level_liters,
//               inflow_rate, outflow_rate, temperature, debris_detected,
//               battery_voltage, signal_strength, firmware_version, time? }
// ══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

async function logIngestError(sensor_id, reason, payload, ip) {
  try {
    await pool.query(
      `INSERT INTO ingest_errors (sensor_id, reason, payload, remote_ip) VALUES ($1,$2,$3,$4)`,
      [sensor_id || null, reason, payload ? JSON.stringify(payload) : null, ip || null]);
  } catch (_) { /* never let logging break ingestion */ }
}

// authenticate the device by its key, resolve which sensor it is
async function authenticateDevice(req, res, next) {
  const key = req.get('X-Device-Key');
  if (!key) {
    await logIngestError(req.body && req.body.sensor_id, 'missing device key', req.body, req.ip);
    return res.status(401).json({ success: false, error: 'Device key required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT sensor_id, client_id, status, driver_id FROM sensors WHERE device_key_hash = $1 LIMIT 1`,
      [hashKey(key)]);
    if (!rows.length) {
      await logIngestError(req.body && req.body.sensor_id, 'unrecognised device key', req.body, req.ip);
      return res.status(401).json({ success: false, error: 'Unrecognised device' });
    }
    req.device = rows[0];
    next();
  } catch (err) {
    console.error('authenticateDevice', err);
    res.status(500).json({ success: false, error: 'Device authentication failed' });
  }
}

const num = (v, lo, hi) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;          // undefined = invalid
  if (n < lo || n > hi) return undefined;
  return n;
};

// POST /monitoring/readings — a node reports in
router.post('/readings', authenticateDevice, async (req, res) => {
  let b = req.body || {};
  const sensorId = req.device.sensor_id;              // trust the key, not the body

  // a device may not claim to be a different sensor (control field, pre-map)
  if (b.sensor_id && b.sensor_id !== sensorId) {
    await logIngestError(sensorId, `sensor_id mismatch (claimed ${b.sensor_id})`, b, req.ip);
    return res.status(403).json({ success: false, error: 'Sensor mismatch' });
  }

  // third-party device abstraction: remap the raw payload to canonical fields
  // via this device's driver (native/unbound → identity, payload already canonical)
  try { b = normalizeReading(await getDriver(req.device.driver_id), b); }
  catch (e) { console.error('[driver normalize]', e.message); }

  const level   = num(b.water_level_percent, 0, 100);
  const liters  = num(b.water_level_liters, 0, 10000000);
  const inflow  = num(b.inflow_rate, 0, 100000);
  const outflow = num(b.outflow_rate, 0, 100000);
  const temp    = num(b.temperature, -20, 80);
  const batt    = num(b.battery_voltage, 0, 6);
  const signal  = num(b.signal_strength, 0, 100);
  const debris  = b.debris_detected === undefined ? null : !!b.debris_detected;

  const invalid = Object.entries({ level, liters, inflow, outflow, temp, batt, signal })
    .filter(([, v]) => v === undefined).map(([k]) => k);
  if (invalid.length) {
    await logIngestError(sensorId, `out-of-range or non-numeric: ${invalid.join(', ')}`, b, req.ip);
    return res.status(400).json({ success: false, error: `Invalid values: ${invalid.join(', ')}` });
  }
  if (level === null && liters === null && inflow === null) {
    await logIngestError(sensorId, 'empty payload — no measurements', b, req.ip);
    return res.status(400).json({ success: false, error: 'Payload contains no measurements' });
  }

  // device may supply its own timestamp (store-and-forward after a comms outage)
  let ts = new Date();
  if (b.time) {
    const t = new Date(b.time);
    if (isNaN(t)) {
      await logIngestError(sensorId, 'unparseable time', b, req.ip);
      return res.status(400).json({ success: false, error: 'Invalid time' });
    }
    // reject clock-skewed future readings beyond a small tolerance
    if (t.getTime() > Date.now() + 10 * 60 * 1000) {
      await logIngestError(sensorId, 'timestamp in the future', b, req.ip);
      return res.status(400).json({ success: false, error: 'Timestamp is in the future' });
    }
    ts = t;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // idempotent: a retried POST for the same (sensor, time) updates rather than duplicates
    await client.query(`
      INSERT INTO sensor_readings
        (sensor_id, time, water_level_percent, water_level_liters,
         inflow_rate, outflow_rate, temperature, debris_detected)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (sensor_id, time) DO UPDATE SET
        water_level_percent = EXCLUDED.water_level_percent,
        water_level_liters  = EXCLUDED.water_level_liters,
        inflow_rate         = EXCLUDED.inflow_rate,
        outflow_rate        = EXCLUDED.outflow_rate,
        temperature         = EXCLUDED.temperature,
        debris_detected     = EXCLUDED.debris_detected`,
      [sensorId, ts, level, liters, inflow, outflow, temp, debris]);

    // the node's own vitals live on the sensors row
    await client.query(`
      UPDATE sensors SET
        last_ping        = GREATEST(COALESCE(last_ping, $2), $2),
        battery_voltage  = COALESCE($3, battery_voltage),
        signal_strength  = COALESCE($4, signal_strength),
        firmware_version = COALESCE($5, firmware_version),
        updated_at       = NOW()
      WHERE sensor_id = $1`,
      [sensorId, ts, batt, signal, b.firmware_version || null]);

    // fold in integrity signals (clock skew, geofence, tamper) — best-effort
    try { await applyIntegrity(client, sensorId, b); }
    catch (e) { console.error('[applyIntegrity]', e.message); }

    // hand over queued commands — store-and-forward: "delivery" happens here,
    // piggybacked on the node's own reporting cadence.
    // 1) lapse any that expired while the device was offline
    await client.query(
      `UPDATE device_commands SET status = 'expired'
        WHERE sensor_id = $1 AND status = 'queued' AND expires_at IS NOT NULL AND expires_at < NOW()`, [sensorId]);
    // 2) re-check safety NOW for disruptive commands (conditions may have changed
    //    since they were queued) using this fresh reading; hold rather than deliver.
    const { rows: queued } = await client.query(
      `SELECT id, command_type, payload FROM device_commands
        WHERE sensor_id = $1 AND status = 'queued' ORDER BY created_at`, [sensorId]);
    const isDisr = c => DISRUPTIVE_COMMANDS.includes(c.command_type);
    let holdReason = null;
    if (queued.some(isDisr)) holdReason = await disruptiveUnsafe(sensorId, level);
    let pending;
    if (holdReason) {
      const deliverIds = queued.filter(c => !isDisr(c)).map(c => c.id);
      const holdIds    = queued.filter(isDisr).map(c => c.id);
      if (deliverIds.length) await client.query(`UPDATE device_commands SET status='delivered', delivered_at=NOW() WHERE id = ANY($1)`, [deliverIds]);
      if (holdIds.length)    await client.query(`UPDATE device_commands SET hold_reason=$2, held_at=NOW() WHERE id = ANY($1)`, [holdIds, holdReason]);
      pending = queued.filter(c => !isDisr(c));
    } else {
      if (queued.length) await client.query(`UPDATE device_commands SET status='delivered', delivered_at=NOW(), hold_reason=NULL WHERE sensor_id=$1 AND status='queued'`, [sensorId]);
      pending = queued;
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { sensor_id: sensorId, recorded_at: ts },
      commands: pending.map(p => ({ id: p.id, type: p.command_type, payload: p.payload })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /monitoring/readings', err);
    await logIngestError(sensorId, `db error: ${err.message}`, b, req.ip);
    res.status(500).json({ success: false, error: 'Failed to record reading' });
  } finally {
    client.release();
  }
});

// POST /monitoring/sensors/:sensorId/device-key — issue/rotate a device key (ops only)
// Returns the plaintext key ONCE; only its hash is stored.
router.post('/sensors/:sensorId/device-key', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const key = 'fgd_' + crypto.randomBytes(24).toString('hex');
    const { rowCount } = await pool.query(
      `UPDATE sensors SET device_key_hash = $1, device_key_set_at = NOW() WHERE sensor_id = $2`,
      [hashKey(key), req.params.sensorId]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Sensor not found' });

    res.json({
      success: true,
      data: { sensor_id: req.params.sensorId, device_key: key,
              note: 'Store this now — it cannot be retrieved again.' },
    });
  } catch (err) {
    console.error('POST device-key', err);
    res.status(500).json({ success: false, error: 'Failed to issue device key' });
  }
});

// GET /monitoring/ingest-errors — recent rejected payloads (ops only)
router.get('/ingest-errors', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const { rows } = await pool.query(
      `SELECT * FROM ingest_errors ORDER BY occurred_at DESC LIMIT 50`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /monitoring/ingest-errors', err);
    res.status(500).json({ success: false, error: 'Failed to load ingest errors' });
  }
});


// ══════════════════════════════════════════════════════════════
//  SENTINEL COVERAGE — a node monitors one or MORE nearby assets
// ══════════════════════════════════════════════════════════════

// PUT /monitoring/sensors/:sensorId/coverage  { assets: [{property_id, is_primary}] }
router.put('/sensors/:sensorId/coverage', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const assets = Array.isArray(req.body.assets) ? req.body.assets : [];
    const primaries = assets.filter(a => a.is_primary);
    if (primaries.length > 1) {
      return res.status(400).json({ success: false, error: 'A node can have only one primary asset' });
    }

    await client.query('BEGIN');
    const { rows: sRows } = await client.query(
      `SELECT sensor_id, client_id FROM sensors WHERE sensor_id = $1 FOR UPDATE`, [req.params.sensorId]);
    if (!sRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Sensor not found' }); }
    const sensor = sRows[0];

    // every asset must belong to this node's client (directly, via its owning
    // user, or by sitting under a parent that does)
    for (const a of assets) {
      const { rows } = await client.query(`
        SELECT p.property_id
          FROM properties p
          LEFT JOIN users u   ON u.id = p.user_id
          LEFT JOIN properties par ON par.property_id = p.parent_property_id
         WHERE p.property_id = $1
           AND ($2::int IS NULL
                OR p.client_id = $2 OR u.client_id = $2 OR par.client_id = $2)`,
        [a.property_id, sensor.client_id]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: `Asset ${a.property_id} does not belong to this node's client` });
      }
    }

    // replace the coverage set wholesale — simpler to reason about than diffing
    await client.query(`DELETE FROM sentinel_coverage WHERE sensor_id = $1`, [req.params.sensorId]);
    for (const a of assets) {
      await client.query(
        `INSERT INTO sentinel_coverage (sensor_id, property_id, is_primary, note)
         VALUES ($1,$2,$3,$4)`,
        [req.params.sensorId, a.property_id, !!a.is_primary, a.note || null]);
    }

    // keep sensors.property_id as a mirror of the primary, for legacy reads
    const primary = primaries[0] || assets[0] || null;
    await client.query(`UPDATE sensors SET property_id = $2, updated_at = NOW() WHERE sensor_id = $1`,
      [req.params.sensorId, primary ? primary.property_id : null]);

    await client.query('COMMIT');
    res.json({ success: true, data: { sensor_id: req.params.sensorId, covered: assets.length } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT coverage', err);
    res.status(500).json({ success: false, error: 'Failed to save coverage' });
  } finally {
    client.release();
  }
});

// GET /monitoring/sensors/:sensorId/events — calibration / firmware / repair history
router.get('/sensors/:sensorId/events', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const { rows } = await pool.query(`
      SELECT de.*, u.full_name AS performed_by_name
        FROM device_events de
        LEFT JOIN users u ON u.id = de.performed_by
       WHERE de.sensor_id = $1
       ORDER BY de.occurred_at DESC LIMIT 50`, [req.params.sensorId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET device events', err);
    res.status(500).json({ success: false, error: 'Failed to load device history' });
  }
});

// POST /monitoring/sensors/:sensorId/events  { event_type, detail? }
router.post('/sensors/:sensorId/events', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const VALID = ['calibration','firmware_update','battery_swap','repair','diagnostic','install','decommission'];
    if (!VALID.includes(req.body.event_type)) {
      return res.status(400).json({ success: false, error: `event_type must be one of: ${VALID.join(', ')}` });
    }
    const { rows } = await pool.query(`
      INSERT INTO device_events (sensor_id, event_type, detail, metadata, performed_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.sensorId, req.body.event_type, req.body.detail || null,
       req.body.metadata ? JSON.stringify(req.body.metadata) : null, req.user.id]);

    // a calibration resets the clock
    if (req.body.event_type === 'calibration') {
      await pool.query(
        `UPDATE sensors SET last_calibrated_at = NOW(),
                calibration_due_at = NOW() + INTERVAL '180 days', updated_at = NOW()
          WHERE sensor_id = $1`, [req.params.sensorId]);
    }
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST device event', err);
    res.status(500).json({ success: false, error: 'Failed to record device event' });
  }
});

// ══════════════════════════════════════════════════════════════
//  REMOTE DEVICE COMMANDS — queue OTA/reset/recalibrate for a node
//  Store-and-forward: a command sits 'queued' until the node's next
//  check-in (POST /monitoring/readings), which is where it's handed over.
// ══════════════════════════════════════════════════════════════

// The remote-action vocabulary. `disruptive` commands take the node offline or
// wipe its state and are gated by the command-safety policy; `needs` validates
// the payload for parameterised commands.
const COMMAND_TYPES = {
  firmware_update:        { disruptive: true, needs: b => (b.payload && b.payload.firmware_version) ? null : 'firmware_update requires payload.firmware_version' },
  reset:                  { disruptive: true },   // reboot
  reset_config:           { disruptive: true },   // revert config to defaults
  factory_reset:          { disruptive: true },   // wipe to factory state
  reprovision:            { disruptive: true },   // re-enrol / rotate identity
  recalibrate:            {},
  apply_config:           {},
  force_sync:             {},   // report in immediately
  connectivity_test:      {},   // uplink echo / ping
  self_test:              {},   // onboard diagnostics
  reconnect_modem:        {},   // cycle the cellular link
  refresh_gps:            {},   // re-acquire a GPS fix
  diagnostic_bundle:      {},   // collect + upload logs
  locate:                 {},   // blink LED / buzzer to identify in the field
  set_reporting_interval: { needs: b => { const n = b.payload && Number(b.payload.interval_seconds); return (n >= 30 && n <= 86400) ? null : 'set_reporting_interval requires payload.interval_seconds (30–86400)'; } },
  set_thresholds:         { needs: b => (b.payload && b.payload.thresholds && typeof b.payload.thresholds === 'object') ? null : 'set_thresholds requires a payload.thresholds object' },
  enable_sensor:          { needs: b => (b.payload && b.payload.channel) ? null : 'enable_sensor requires payload.channel' },
  disable_sensor:         { needs: b => (b.payload && b.payload.channel) ? null : 'disable_sensor requires payload.channel' },
};
const VALID_COMMANDS = Object.keys(COMMAND_TYPES);
const DISRUPTIVE_COMMANDS = VALID_COMMANDS.filter(k => COMMAND_TYPES[k].disruptive);

function validateCommandBody(body) {
  const spec = COMMAND_TYPES[body.command_type];
  if (!spec) return `command_type must be one of: ${VALID_COMMANDS.join(', ')}`;
  return spec.needs ? spec.needs(body) : null;
}

// ── Protection (maintenance) windows ──────────────────────────────────────
// Return the active protection window covering a sensor, or null. A window
// covers a sensor when scope matches: whole fleet, one of its tags, its
// property, or the sensor itself — and NOW is between starts/ends, not cancelled.
async function activeProtection(sensorId) {
  const s = (await pool.query('SELECT property_id, tags FROM sensors WHERE sensor_id = $1', [sensorId])).rows[0];
  if (!s) return null;
  const { rows } = await pool.query(`
    SELECT id, scope_type, scope_value, reason, ends_at
      FROM device_protection_windows
     WHERE cancelled_at IS NULL AND NOW() BETWEEN starts_at AND ends_at
       AND ( scope_type = 'fleet'
             OR (scope_type = 'sensor'   AND scope_value = $1)
             OR (scope_type = 'property' AND scope_value = $2)
             OR (scope_type = 'tag'      AND scope_value = ANY($3::text[])) )
     ORDER BY ends_at DESC LIMIT 1`,
    [sensorId, s.property_id, s.tags || []]);
  return rows[0] || null;
}

// Why a disruptive command (reboot/firmware) is unsafe for this sensor right
// now, or null. Reused at enqueue AND re-checked at delivery — a command queued
// while calm must not be handed to the device mid-flood. Pass freshLevel when
// the device is checking in (that reading is authoritative and trusted).
async function disruptiveUnsafe(sensorId, freshLevel) {
  const win = await activeProtection(sensorId);
  if (win) return `A protection window is active (${win.scope_type}${win.reason ? ' — ' + win.reason : ''}) until ${new Date(win.ends_at).toISOString()}.`;
  let level, propertyId, trusted;
  if (freshLevel !== undefined) {
    level = freshLevel; trusted = true;
    propertyId = (await pool.query('SELECT property_id FROM sensors WHERE sensor_id = $1', [sensorId])).rows[0]?.property_id;
  } else {
    const cur = (await pool.query(`
      SELECT s.status, s.last_ping, s.property_id, r.water_level_percent AS level, r.time AS reading_time
        FROM sensors s
        LEFT JOIN LATERAL (SELECT water_level_percent, time FROM sensor_readings WHERE sensor_id=s.sensor_id ORDER BY time DESC LIMIT 1) r ON true
       WHERE s.sensor_id = $1`, [sensorId])).rows[0];
    if (!cur) return null;
    const now = Date.now();
    const readAge = cur.reading_time ? (now - new Date(cur.reading_time).getTime()) / 60000 : null;
    const pingAge = cur.last_ping ? (now - new Date(cur.last_ping).getTime()) / 60000 : null;
    level = cur.level != null ? parseFloat(cur.level) : null; propertyId = cur.property_id;
    trusted = cur.status === 'active' && pingAge != null && pingAge <= 360 && readAge != null && readAge <= 90 && level != null && level >= 0 && level <= 100;
  }
  if (!(trusted && level != null && level >= 70)) return null;
  const sib = (await pool.query(`
    SELECT COUNT(*)::int AS n FROM sensors s2
     WHERE s2.sensor_id <> $1 AND s2.status = 'active' AND s2.last_ping > NOW() - INTERVAL '6 hours'
       AND ( s2.property_id = $2
             OR s2.sensor_id IN (SELECT sensor_id FROM sentinel_coverage
                                  WHERE property_id IN (SELECT property_id FROM sentinel_coverage WHERE sensor_id = $1)) )`,
    [sensorId, propertyId])).rows[0].n;
  return sib === 0 ? 'This is the only node reporting on a channel that is at high water right now.' : null;
}

// GET /monitoring/protection-windows — active + upcoming (not cancelled/expired)
router.get('/protection-windows', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const { rows } = await pool.query(`
      SELECT w.*, u.full_name AS created_by_name,
             (NOW() BETWEEN w.starts_at AND w.ends_at) AS active
        FROM device_protection_windows w
        LEFT JOIN users u ON u.id = w.created_by
       WHERE w.cancelled_at IS NULL AND w.ends_at > NOW()
       ORDER BY w.starts_at`);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET protection-windows', err); res.status(500).json({ success: false, error: 'Failed to load windows' }); }
});

// POST /monitoring/protection-windows  { scope_type, scope_value?, reason, starts_at?, ends_at }
router.post('/protection-windows', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    if (denyTenant(req, res)) return;
    const b = req.body || {};
    const SCOPES = ['fleet', 'tag', 'property', 'sensor'];
    if (!SCOPES.includes(b.scope_type)) return res.status(400).json({ success: false, error: 'Invalid scope_type' });
    if (b.scope_type !== 'fleet' && !b.scope_value) return res.status(400).json({ success: false, error: 'scope_value required for this scope' });
    if (!b.ends_at) return res.status(400).json({ success: false, error: 'ends_at required' });
    if (new Date(b.ends_at) <= (b.starts_at ? new Date(b.starts_at) : new Date())) return res.status(400).json({ success: false, error: 'ends_at must be in the future' });
    const { rows } = await pool.query(`
      INSERT INTO device_protection_windows (scope_type, scope_value, reason, starts_at, ends_at, created_by)
      VALUES ($1,$2,$3,COALESCE($4,NOW()),$5,$6) RETURNING *`,
      [b.scope_type, b.scope_type === 'fleet' ? null : String(b.scope_value), b.reason || null,
       b.starts_at || null, b.ends_at, req.user.id]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { console.error('POST protection-windows', err); res.status(500).json({ success: false, error: 'Failed to create window' }); }
});

// POST /monitoring/protection-windows/:id/cancel
router.post('/protection-windows/:id/cancel', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    if (denyTenant(req, res)) return;
    const { rowCount } = await pool.query(
      `UPDATE device_protection_windows SET cancelled_at = NOW() WHERE id = $1 AND cancelled_at IS NULL`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Window not found' });
    res.json({ success: true });
  } catch (err) { console.error('cancel protection-window', err); res.status(500).json({ success: false, error: 'Failed to cancel' }); }
});

// ── Device lifecycle + hardware inventory + RMA ───────────────────────────
const LIFECYCLE = ['inventory','warehouse','assigned','installed','active','maintenance','rma','retired'];
async function logLifecycle(sensorId, event, fromState, toState, detail, actorId) {
  try {
    await pool.query(
      `INSERT INTO device_lifecycle_events (sensor_id, event, from_state, to_state, detail, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sensorId, event, fromState || null, toState || null, detail ? JSON.stringify(detail) : null, actorId || null]);
  } catch (e) { console.error('[logLifecycle]', e.message); }
}

// ── Device integrity (time-sync / geofence / tamper) ──────────────────────
const CLOCK_SKEW_LIMIT_S = 300;   // beyond ±5 min is a drift worth flagging
async function logIntegrity(runner, sensorId, kind, detail, actorId) {
  try {
    await (runner || pool).query(
      `INSERT INTO device_integrity_events (sensor_id, kind, detail, actor_id) VALUES ($1,$2,$3,$4)`,
      [sensorId, kind, detail ? JSON.stringify(detail) : null, actorId || null]);
  } catch (e) { console.error('[logIntegrity]', e.message); }
}
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}
// Derive an integrity verdict from a sensor row (used by /sensors/all).
function integrityOf(s) {
  const reasons = [];
  if (s.tamper_flagged) reasons.push('tamper flagged');
  if (s.geofence_state === 'breach') reasons.push(`outside geofence (${s.geofence_distance_m ?? '?'} m)`);
  if (s.last_clock_skew_seconds != null && Math.abs(s.last_clock_skew_seconds) >= CLOCK_SKEW_LIMIT_S)
    reasons.push(`clock skew ${Math.round(s.last_clock_skew_seconds / 60)} min`);
  const state = s.tamper_flagged ? 'critical'
    : reasons.length ? 'warning'
    : (s.geofence_state === 'unknown' && s.clock_synced_at == null) ? 'unknown' : 'ok';
  return { integrity_state: state, integrity_reasons: reasons };
}
// Called inside the readings txn: fold optional device-clock, GPS and tamper
// signals into the sensor's integrity state, logging transitions.
async function applyIntegrity(client, sensorId, b) {
  const cur = (await client.query(
    `SELECT geofence_center_lat, geofence_center_lng, geofence_radius_m, geofence_state,
            tamper_flagged, last_clock_skew_seconds
       FROM sensors WHERE sensor_id = $1 FOR UPDATE`, [sensorId])).rows[0];
  if (!cur) return;

  // time-sync: device sends its current wall-clock as `device_clock`
  if (b.device_clock) {
    const dc = new Date(b.device_clock);
    if (!isNaN(dc)) {
      const skew = Math.round((Date.now() - dc.getTime()) / 1000);
      await client.query(`UPDATE sensors SET last_clock_skew_seconds=$2, clock_synced_at=NOW() WHERE sensor_id=$1`, [sensorId, skew]);
      const was = cur.last_clock_skew_seconds;
      if (Math.abs(skew) >= CLOCK_SKEW_LIMIT_S && (was == null || Math.abs(was) < CLOCK_SKEW_LIMIT_S))
        await logIntegrity(client, sensorId, 'clock_drift', { skew_seconds: skew }, null);
    }
  }

  // geofence: device reports GPS → update position, compare to the anchor
  const lat = num(b.latitude, -90, 90), lng = num(b.longitude, -180, 180);
  if (lat != null && lng != null) {
    await client.query(`UPDATE sensors SET latitude=$2, longitude=$3 WHERE sensor_id=$1`, [sensorId, lat, lng]);
    if (cur.geofence_center_lat != null && cur.geofence_center_lng != null) {
      const dist = haversineM(+cur.geofence_center_lat, +cur.geofence_center_lng, lat, lng);
      const state = dist <= (cur.geofence_radius_m || 150) ? 'inside' : 'breach';
      await client.query(`UPDATE sensors SET geofence_state=$2, geofence_distance_m=$3 WHERE sensor_id=$1`, [sensorId, state, dist]);
      if (state === 'breach' && cur.geofence_state !== 'breach')
        await logIntegrity(client, sensorId, 'geofence_breach', { distance_m: dist, radius_m: cur.geofence_radius_m }, null);
      else if (state === 'inside' && cur.geofence_state === 'breach')
        await logIntegrity(client, sensorId, 'geofence_ok', { distance_m: dist }, null);
    }
  }

  // tamper: device raises a tamper flag (enclosure/orientation)
  if (b.tamper === true && !cur.tamper_flagged) {
    await client.query(`UPDATE sensors SET tamper_flagged=TRUE, tamper_at=NOW(), tamper_reason=$2 WHERE sensor_id=$1`,
      [sensorId, String(b.tamper_reason || 'device-reported').slice(0, 200)]);
    await logIntegrity(client, sensorId, 'tamper_raised', { source: 'device', reason: b.tamper_reason || 'device-reported' }, null);
  }
}

// PUT /monitoring/sensors/:id/driver  { driver_id }  — bind a device to a driver
// (null unbinds → treated as native). Provisioning action: FlowGuard ops only.
router.put('/sensors/:sensorId/driver', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    if (denyTenant(req, res)) return;
    const did = (req.body || {}).driver_id;
    if (did != null) {
      const d = (await pool.query('SELECT id FROM device_drivers WHERE id = $1 AND active = TRUE', [did])).rows[0];
      if (!d) return res.status(400).json({ success: false, error: 'Unknown or inactive driver' });
    }
    const { rows } = await pool.query(
      `UPDATE sensors SET driver_id = $2, updated_at = NOW() WHERE sensor_id = $1 RETURNING sensor_id, driver_id`,
      [req.params.sensorId, did == null ? null : did]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT driver', err); res.status(500).json({ success: false, error: 'Failed to set driver' }); }
});

// PUT /monitoring/sensors/:id/geofence  { center_lat, center_lng, radius_m } | { anchor:true }
// `anchor:true` pins the fence to the device's current reported position.
router.put('/sensors/:sensorId/geofence', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const b = req.body || {};
    const cur = (await pool.query('SELECT latitude, longitude, geofence_radius_m FROM sensors WHERE sensor_id=$1', [req.params.sensorId])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Sensor not found' });

    let lat, lng;
    if (b.anchor === true) {
      if (cur.latitude == null || cur.longitude == null) return res.status(400).json({ success: false, error: 'Device has no reported position to anchor to' });
      lat = +cur.latitude; lng = +cur.longitude;
    } else {
      lat = num(b.center_lat, -90, 90); lng = num(b.center_lng, -180, 180);
      if (lat == null || lng == null) return res.status(400).json({ success: false, error: 'center_lat and center_lng (or anchor:true) required' });
    }
    let radius = cur.geofence_radius_m || 150;
    if (b.radius_m != null) { const r = num(b.radius_m, 10, 100000); if (r == null) return res.status(400).json({ success: false, error: 'radius_m must be 10–100000' }); radius = Math.round(r); }

    const { rows } = await pool.query(
      `UPDATE sensors SET geofence_center_lat=$2, geofence_center_lng=$3, geofence_radius_m=$4,
              geofence_state='unknown', geofence_distance_m=NULL, updated_at=NOW()
        WHERE sensor_id=$1 RETURNING geofence_center_lat, geofence_center_lng, geofence_radius_m`,
      [req.params.sensorId, lat, lng, radius]);
    await logIntegrity(pool, req.params.sensorId, 'geofence_anchor_set', { center: [lat, lng], radius_m: radius, anchored: b.anchor === true }, req.user.id);
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT geofence', err); res.status(500).json({ success: false, error: 'Failed to set geofence' }); }
});

// POST /monitoring/sensors/:id/tamper  { flagged:boolean, reason? }  — raise/clear
router.post('/sensors/:sensorId/tamper', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const b = req.body || {};
    const flag = b.flagged === true;
    if (flag) {
      const { rows } = await pool.query(
        `UPDATE sensors SET tamper_flagged=TRUE, tamper_at=NOW(), tamper_reason=$2, updated_at=NOW()
          WHERE sensor_id=$1 RETURNING tamper_flagged`, [req.params.sensorId, String(b.reason || 'flagged by ops').slice(0, 200)]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
      await logIntegrity(pool, req.params.sensorId, 'tamper_raised', { source: 'ops', reason: b.reason || 'flagged by ops' }, req.user.id);
    } else {
      const { rows } = await pool.query(
        `UPDATE sensors SET tamper_flagged=FALSE, tamper_reason=NULL, tamper_at=NULL, updated_at=NOW()
          WHERE sensor_id=$1 RETURNING tamper_flagged`, [req.params.sensorId]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
      await logIntegrity(pool, req.params.sensorId, 'tamper_cleared', { note: b.reason || null }, req.user.id);
    }
    res.json({ success: true, data: { tamper_flagged: flag } });
  } catch (err) { console.error('POST tamper', err); res.status(500).json({ success: false, error: 'Failed to update tamper flag' }); }
});

// PUT /monitoring/sensors/:id/lifecycle  { lifecycle_state, note? }
router.put('/sensors/:sensorId/lifecycle', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const to = (req.body || {}).lifecycle_state;
    if (!LIFECYCLE.includes(to)) return res.status(400).json({ success: false, error: 'Invalid lifecycle_state' });
    const cur = (await pool.query('SELECT lifecycle_state FROM sensors WHERE sensor_id = $1', [req.params.sensorId])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Sensor not found' });
    await pool.query('UPDATE sensors SET lifecycle_state = $2, updated_at = NOW() WHERE sensor_id = $1', [req.params.sensorId, to]);
    await logLifecycle(req.params.sensorId, 'state_change', cur.lifecycle_state, to, (req.body || {}).note ? { note: req.body.note } : null, req.user.id);
    res.json({ success: true, data: { lifecycle_state: to } });
  } catch (err) { console.error('PUT lifecycle', err); res.status(500).json({ success: false, error: 'Failed to update lifecycle' }); }
});

// PUT /monitoring/sensors/:id/hardware — manufacturing / identity fields
router.put('/sensors/:sensorId/hardware', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const b = req.body || {};
    const s = v => v == null || v === '' ? null : String(v).slice(0, 64);
    const { rows } = await pool.query(
      `UPDATE sensors SET serial_number=$2, hardware_rev=$3, manufacturing_batch=$4,
              modem_imei=$5, sim_iccid=$6, install_date=$7, warranty_expires_at=$8, updated_at=NOW()
        WHERE sensor_id=$1
        RETURNING serial_number, hardware_rev, manufacturing_batch, modem_imei, sim_iccid, install_date, warranty_expires_at`,
      [req.params.sensorId, s(b.serial_number), s(b.hardware_rev), s(b.manufacturing_batch),
       s(b.modem_imei), s(b.sim_iccid), b.install_date || null, b.warranty_expires_at || null]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT hardware', err); res.status(500).json({ success: false, error: 'Failed to update hardware' }); }
});

// GET /monitoring/sensors/:id/lifecycle — event log (transitions, RMA, notes)
router.get('/sensors/:sensorId/lifecycle', authenticateToken, async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const { rows } = await pool.query(`
      SELECT e.*, u.full_name AS actor_name FROM device_lifecycle_events e
        LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.sensor_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [req.params.sensorId]);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('GET lifecycle', err); res.status(500).json({ success: false, error: 'Failed to load lifecycle' }); }
});

// GET /monitoring/sensors/:id/timeline — one chronological feed unifying
// maintenance events, command activity and lifecycle transitions.
router.get('/sensors/:sensorId/timeline', authenticateToken, async (req, res) => {
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const id = req.params.sensorId;
    const [ev, cmd, life, intg] = await Promise.all([
      pool.query(`SELECT de.event_type, de.detail, de.occurred_at, u.full_name AS actor
                    FROM device_events de LEFT JOIN users u ON u.id = de.performed_by
                   WHERE de.sensor_id = $1 ORDER BY de.occurred_at DESC LIMIT 60`, [id]),
      pool.query(`SELECT dc.command_type, dc.status, dc.note, dc.hold_reason,
                         dc.created_at, dc.delivered_at, dc.held_at, dc.cancelled_at, u.full_name AS actor
                    FROM device_commands dc LEFT JOIN users u ON u.id = dc.requested_by
                   WHERE dc.sensor_id = $1 ORDER BY dc.created_at DESC LIMIT 60`, [id]),
      pool.query(`SELECT e.event, e.from_state, e.to_state, e.detail, e.created_at, u.full_name AS actor
                    FROM device_lifecycle_events e LEFT JOIN users u ON u.id = e.actor_id
                   WHERE e.sensor_id = $1 ORDER BY e.created_at DESC LIMIT 60`, [id]),
      pool.query(`SELECT ie.kind, ie.detail, ie.created_at, u.full_name AS actor
                    FROM device_integrity_events ie LEFT JOIN users u ON u.id = ie.actor_id
                   WHERE ie.sensor_id = $1 ORDER BY ie.created_at DESC LIMIT 60`, [id]),
    ]);

    const feed = [];
    for (const r of ev.rows) {
      feed.push({ ts: r.occurred_at, source: 'maintenance', kind: r.event_type,
        title: String(r.event_type || 'event').replace(/_/g, ' '), detail: r.detail || null, actor: r.actor || null });
    }
    for (const r of cmd.rows) {
      // most recent meaningful state stamp for the command
      const ts = r.cancelled_at || r.delivered_at || r.held_at || r.created_at;
      const tone = r.status === 'failed' ? 'err'
        : r.status === 'cancelled' || r.status === 'expired' ? 'muted'
        : r.hold_reason ? 'warn'
        : r.status === 'delivered' || r.status === 'acknowledged' ? 'ok' : 'info';
      feed.push({ ts, source: 'command', kind: r.command_type, tone,
        title: `${String(r.command_type || 'command').replace(/_/g, ' ')} · ${r.status}`,
        detail: r.hold_reason ? `Held: ${r.hold_reason}` : (r.note || null), actor: r.actor || null });
    }
    for (const r of life.rows) {
      const note = r.detail && (r.detail.note || r.detail.reason) ? (r.detail.note || r.detail.reason) : null;
      const tone = r.event === 'rma_out' ? 'err' : r.event === 'rma_in' ? 'ok' : r.event === 'replaced_by' ? 'warn' : 'info';
      feed.push({ ts: r.created_at, source: 'lifecycle', kind: r.event, tone,
        title: r.from_state || r.to_state ? `${String(r.event).replace(/_/g, ' ')}: ${r.from_state || '—'} → ${r.to_state || '—'}` : String(r.event).replace(/_/g, ' '),
        detail: note, actor: r.actor || null });
    }
    for (const r of intg.rows) {
      const map = {
        geofence_breach: ['err', 'Geofence breach'], geofence_ok: ['ok', 'Geofence restored'],
        geofence_anchor_set: ['info', 'Geofence anchor set'], tamper_raised: ['err', 'Tamper flagged'],
        tamper_cleared: ['ok', 'Tamper cleared'], clock_drift: ['warn', 'Clock drift'],
      }[r.kind] || ['info', String(r.kind).replace(/_/g, ' ')];
      const d = r.detail || {};
      const detail = d.distance_m != null ? `${d.distance_m} m from anchor`
        : d.skew_seconds != null ? `${Math.round(d.skew_seconds / 60)} min skew`
        : d.reason || d.note || null;
      feed.push({ ts: r.created_at, source: 'integrity', kind: r.kind, tone: map[0], title: map[1], detail, actor: r.actor || null });
    }
    feed.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ success: true, data: feed.slice(0, 80) });
  } catch (err) {
    console.error('GET timeline', err);
    res.status(500).json({ success: false, error: 'Failed to load timeline' });
  }
});

// POST /monitoring/sensors/:id/replace  { replacement_sensor_id, note? }
// RMA transfer: move property, coverage, tags, profile from the failed unit to
// its replacement; retire the old (rma) and bring the new online.
router.post('/sensors/:sensorId/replace', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    if (denyTenant(req, res)) return;   // client released by finally
    const oldId = req.params.sensorId, newId = (req.body || {}).replacement_sensor_id;
    if (!newId) return res.status(400).json({ success: false, error: 'replacement_sensor_id required' });
    if (newId === oldId) return res.status(400).json({ success: false, error: 'Replacement must be a different device' });
    const rows = (await client.query('SELECT sensor_id, lifecycle_state, property_id, tags, profile_id FROM sensors WHERE sensor_id = ANY($1)', [[oldId, newId]])).rows;
    const oldS = rows.find(r => r.sensor_id === oldId), newS = rows.find(r => r.sensor_id === newId);
    if (!oldS || !newS) return res.status(404).json({ success: false, error: 'Old or replacement device not found' });

    await client.query('BEGIN');
    // move property, tags, profile to the replacement; reset its applied config version
    await client.query(`UPDATE sensors SET property_id=$2, tags=$3, profile_id=$4, applied_profile_version=NULL,
                          lifecycle_state='active', updated_at=NOW() WHERE sensor_id=$1`,
      [newId, oldS.property_id, oldS.tags, oldS.profile_id]);
    // move coverage rows (skip any that would collide on the replacement)
    await client.query(`
      UPDATE sentinel_coverage sc SET sensor_id=$2
       WHERE sc.sensor_id=$1
         AND NOT EXISTS (SELECT 1 FROM sentinel_coverage x WHERE x.sensor_id=$2 AND x.property_id=sc.property_id)`,
      [oldId, newId]);
    await client.query(`DELETE FROM sentinel_coverage WHERE sensor_id=$1`, [oldId]);
    // retire the failed unit, detach it from the property/profile
    await client.query(`UPDATE sensors SET lifecycle_state='rma', property_id=NULL, profile_id=NULL, updated_at=NOW() WHERE sensor_id=$1`, [oldId]);
    const detail = { counterpart: newId, note: (req.body || {}).note || null };
    await logLifecycle(oldId, 'rma_out', oldS.lifecycle_state, 'rma', { replaced_by: newId, note: detail.note }, req.user.id);
    await logLifecycle(newId, 'rma_in', newS.lifecycle_state, 'active', { replaces: oldId, note: detail.note }, req.user.id);
    await client.query('COMMIT');
    res.json({ success: true, data: { old: oldId, replacement: newId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST replace', err); res.status(500).json({ success: false, error: 'Failed to transfer' });
  } finally { client.release(); }
});

// ── Device tags (grouping / bulk targeting) ───────────────────────────────
// Normalise a tag: lowercase, trim, spaces→hyphen, safe charset, capped length.
function cleanTag(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_\-.]/g, '').slice(0, 32);
}
function cleanTags(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).map(cleanTag).filter(Boolean))].slice(0, 20);
}

// PUT /monitoring/sensors/:sensorId/tags  { tags:[] }  → replace this node's tags
router.put('/sensors/:sensorId/tags', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const tags = cleanTags((req.body || {}).tags);
    const { rows } = await pool.query(
      `UPDATE sensors SET tags = $2 WHERE sensor_id = $1 RETURNING sensor_id, tags`,
      [req.params.sensorId, tags]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('PUT sensor tags', err); res.status(500).json({ success: false, error: 'Failed to update tags' }); }
});

// POST /monitoring/sensors/tags/bulk  { sensor_ids:[], add:[], remove:[] }
router.post('/sensors/tags/bulk', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    let ids = Array.isArray(req.body.sensor_ids) ? req.body.sensor_ids : [];
    // multi-tenant isolation: keep only targets within the caller's tenancy
    const scope = await deviceSensorScope(req);
    if (scope) { const set = new Set(scope); ids = ids.filter(id => set.has(id)); }
    const add = cleanTags(req.body.add), remove = cleanTags(req.body.remove);
    if (!ids.length || (!add.length && !remove.length))
      return res.status(400).json({ success: false, error: 'sensor_ids (within your scope) and at least one of add/remove required' });
    // add via array_cat + dedupe, then strip removed — done in SQL per row
    const { rowCount } = await pool.query(
      `UPDATE sensors
          SET tags = (
            SELECT ARRAY(
              SELECT DISTINCT t FROM unnest(array_cat(tags, $2::text[])) AS t
               WHERE t <> ALL ($3::text[])
            ))
        WHERE sensor_id = ANY($1)`,
      [ids, add, remove]);
    res.json({ success: true, data: { updated: rowCount } });
  } catch (err) { console.error('POST bulk tags', err); res.status(500).json({ success: false, error: 'Failed to update tags' }); }
});

// GET /monitoring/sensors/:sensorId/commands — queued + past commands for one node
router.get('/sensors/:sensorId/commands', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const { rows } = await pool.query(`
      SELECT dc.*, u.full_name AS requested_by_name
        FROM device_commands dc
        LEFT JOIN users u ON u.id = dc.requested_by
       WHERE dc.sensor_id = $1
       ORDER BY dc.created_at DESC LIMIT 50`, [req.params.sensorId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET device commands', err);
    res.status(500).json({ success: false, error: 'Failed to load command history' });
  }
});

// POST /monitoring/sensors/:sensorId/commands  { command_type, payload?, note? }
router.post('/sensors/:sensorId/commands', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const badReq = validateCommandBody(req.body);
    if (badReq) return res.status(400).json({ success: false, error: badReq });

    const sensorCheck = await pool.query(`SELECT sensor_id, driver_id FROM sensors WHERE sensor_id = $1`, [req.params.sensorId]);
    if (!sensorCheck.rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });

    // third-party abstraction: a device's driver may not support this command
    const driver = await getDriver(sensorCheck.rows[0].driver_id);
    if (!driverSupportsCommand(driver, req.body.command_type)) {
      return res.status(400).json({ success: false, error: `${driver ? driver.name : 'This device'} does not support the "${req.body.command_type}" command` });
    }

    // ── Command-safety policy ──────────────────────────────────────────────
    // A reboot / firmware push takes the node offline for a while. Refuse it if
    // this is the ONLY node still reporting trustworthy data on a channel that
    // is currently at high water — that would blind the drain during a flood
    // window. Ops can still proceed with an explicit override + reason.
    if (DISRUPTIVE_COMMANDS.includes(req.body.command_type) && req.body.override !== true) {
      const reason = await disruptiveUnsafe(req.params.sensorId);
      if (reason) {
        return res.status(409).json({ success: false, safety: true, error: reason,
          override_hint: 'Resend with override:true and a reason to proceed anyway.' });
      }
    }

    const overridden = req.body.override === true && DISRUPTIVE_COMMANDS.includes(req.body.command_type);
    const note = overridden
      ? `[SAFETY OVERRIDE] ${req.body.note || '(no reason given)'}`
      : (req.body.note || null);
    // optional expiry — if the device never reconnects in time, the command lapses
    const ttl = parseInt(req.body.ttl_hours, 10);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 3600 * 1000) : null;

    const { rows } = await pool.query(`
      INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.sensorId, req.body.command_type,
       req.body.payload ? JSON.stringify(req.body.payload) : null,
       req.user.id, note, expiresAt]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST device command', err);
    res.status(500).json({ success: false, error: 'Failed to queue command' });
  }
});

// POST /monitoring/sensors/commands/bulk  { sensor_ids: [...], command_type, payload?, note? }
router.post('/sensors/commands/bulk', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const badReq = validateCommandBody(req.body);
    if (badReq) return res.status(400).json({ success: false, error: badReq });

    const ids = Array.isArray(req.body.sensor_ids) ? req.body.sensor_ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'sensor_ids must be a non-empty array' });
    if (ids.length > 200) return res.status(400).json({ success: false, error: 'Too many sensors in one bulk request (max 200)' });

    const { rows: valid } = await pool.query(
      `SELECT sensor_id FROM sensors WHERE sensor_id = ANY($1)`, [ids]);
    let validIds = valid.map(r => r.sensor_id);
    // multi-tenant isolation: drop any target outside the caller's tenancy
    const scope = await deviceSensorScope(req);
    if (scope) { const set = new Set(scope); validIds = validIds.filter(id => set.has(id)); }
    const skipped = ids.filter(id => !validIds.includes(id));
    if (!validIds.length) return res.status(404).json({ success: false, error: 'None of the given sensors are within your scope' });

    const payload = req.body.payload ? JSON.stringify(req.body.payload) : null;
    const { rows } = await pool.query(`
      INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note)
      SELECT s, $2, $3, $4, $5 FROM UNNEST($1::varchar[]) AS s
      RETURNING id, sensor_id`,
      [validIds, req.body.command_type, payload, req.user.id, req.body.note || null]);

    res.status(201).json({ success: true, data: { queued: rows.length, sensor_ids: rows.map(r => r.sensor_id), skipped } });
  } catch (err) {
    console.error('POST bulk device commands', err);
    res.status(500).json({ success: false, error: 'Failed to queue bulk commands' });
  }
});

// POST /monitoring/sensors/:sensorId/commands/:commandId/cancel — pull back a queued command
router.post('/sensors/:sensorId/commands/:commandId/cancel', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const { rows } = await pool.query(`
      UPDATE device_commands SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND sensor_id = $2 AND status = 'queued'
       RETURNING *`, [req.params.commandId, req.params.sensorId]);
    if (!rows.length) return res.status(409).json({ success: false, error: 'Command not found or already delivered' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST cancel device command', err);
    res.status(500).json({ success: false, error: 'Failed to cancel command' });
  }
});

// ── Incident candidates: automation drafts, a human confirms ──
// GET /monitoring/incident-candidates?status=pending
router.get('/incident-candidates', authenticateToken, async (req, res) => {
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
    const status = req.query.status || 'pending';
    const { rows } = await pool.query(`
      SELECT ic.*, p.property_name, s.name AS sensor_name
        FROM incident_candidates ic
        LEFT JOIN properties p ON p.property_id = ic.property_id
        LEFT JOIN sensors s ON s.sensor_id = ic.sensor_id
       WHERE ic.status = $1
       ORDER BY ic.breach_start DESC LIMIT 50`, [status]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET incident-candidates', err);
    res.status(500).json({ success: false, error: 'Failed to load incident candidates' });
  }
});

// POST /monitoring/incident-candidates/:id/confirm  { confirmed: true|false, note? }
//   confirmed → writes a flood_incident property_event (resets days-flood-free)
//   dismissed → nothing client-facing; a false positive never touches their record
router.post('/incident-candidates/:id/confirm', authenticateToken, requirePermission('devices.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { isClient } = require('../utils/scope');
    if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const confirmed = req.body.confirmed === true;

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM incident_candidates WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Candidate not found' }); }
    const c = rows[0];
    if (c.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `Already ${c.status}` });
    }

    await client.query(
      `UPDATE incident_candidates SET status=$2, resolved_by=$3, resolved_at=NOW(), note=$4 WHERE id=$1`,
      [id, confirmed ? 'confirmed' : 'dismissed', req.user.id, req.body.note || null]);

    if (confirmed && c.property_id) {
      await client.query(`
        INSERT INTO property_events (property_id, event_type, description, metadata, occurred_at, created_by)
        VALUES ($1,'flood_incident',$2,$3,$4,$5)`,
        [c.property_id,
         req.body.note || `Flooding confirmed — water level peaked at ${c.peak_level}% for ${c.duration_min || '?'} min`,
         JSON.stringify({ candidate_id: id, sensor_id: c.sensor_id, peak_level: c.peak_level }),
         c.breach_start, req.user.id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { id, status: confirmed ? 'confirmed' : 'dismissed' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST confirm incident', err);
    res.status(500).json({ success: false, error: 'Failed to update candidate' });
  } finally {
    client.release();
  }
});

module.exports = router;
