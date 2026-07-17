// Client-portal monitoring: flood-risk index + live sensor readings
// Honest by design: returns has_data:false when no real readings exist yet,
// so the UI can show an "awaiting sensor data" state rather than a fake number.
const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const router = express.Router();

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

// GET /monitoring/flood-risk  -> { has_data, risk_index, level, sensors_online, sensors_total, peak_level }
router.get('/flood-risk', authenticateToken, async (req, res) => {
  try {
    const ids = await clientIdsForUser(req.user.id);
    if (!ids.length) {
      return res.json({ success: true, data: { has_data: false, reason: 'no_client', sensors_total: 0 } });
    }

    // "online" = active status AND telemetry within the last 6h, not status
    // alone — status is set once at registration and never updated by ingestion.
    const sensorCount = await pool.query(
      `SELECT COUNT(*) total,
              COUNT(*) FILTER (WHERE status='active' AND last_ping > NOW() - INTERVAL '6 hours') online
         FROM sensors WHERE client_id = ANY($1)`, [ids]);
    const total = parseInt(sensorCount.rows[0].total) || 0;
    const online = parseInt(sensorCount.rows[0].online) || 0;

    // Latest reading per sensor in the last 6 hours
    const latest = await pool.query(
      `SELECT DISTINCT ON (r.sensor_id) r.sensor_id, r.water_level_percent, r.time
         FROM sensor_readings r
         JOIN sensors s ON s.sensor_id = r.sensor_id
        WHERE s.client_id = ANY($1) AND r.time > NOW() - INTERVAL '6 hours'
        ORDER BY r.sensor_id, r.time DESC`, [ids]);

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
    const ids = await clientIdsForUser(req.user.id);
    if (!ids.length) return res.json({ success: true, data: [] });

    const sensors = await pool.query(
      `SELECT s.sensor_id, s.name, s.zone, s.status, s.device_variant,
              s.battery_voltage, s.signal_strength, s.last_ping,
              COALESCE(pp.parent_property_id, pp.property_id) AS property_id,
              s.enzyme_level_percent, s.cartridge_status, s.enzyme_capacity_ml,
              s.enzyme_installed_date, s.estimated_depletion_date, s.daily_dispense_ml
         FROM sensors s
         LEFT JOIN properties pp ON pp.property_id = s.property_id
        WHERE s.client_id = ANY($1) ORDER BY s.name`, [ids]);

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
    const ids = await clientIdsForUser(req.user.id);
    if (!ids.length) return res.json({ success: true, data: { series: [], log: [] } });
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));

    // Raw log: recent readings across the client's sensors (newest first)
    const log = await pool.query(
      `SELECT r.time, r.sensor_id, s.name AS sensor_name,
              r.water_level_percent, r.inflow_rate, r.debris_detected
         FROM sensor_readings r
         JOIN sensors s ON s.sensor_id = r.sensor_id
        WHERE s.client_id = ANY($1) AND r.time > NOW() - ($2 || ' hours')::interval
        ORDER BY r.time DESC
        LIMIT 200`, [ids, hours]);

    // Series: average water level per hour bucket for the trend chart
    const series = await pool.query(
      `SELECT date_trunc('hour', r.time) AS bucket,
              ROUND(AVG(r.water_level_percent)::numeric, 1) AS avg_level,
              ROUND(MAX(r.water_level_percent)::numeric, 1) AS peak_level
         FROM sensor_readings r
         JOIN sensors s ON s.sensor_id = r.sensor_id
        WHERE s.client_id = ANY($1) AND r.time > NOW() - ($2 || ' hours')::interval
        GROUP BY bucket ORDER BY bucket ASC`, [ids, hours]);

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
    const ids = await clientIdsForUser(req.user.id);
    if (!ids.length) return res.status(404).json({ success: false, error: 'Not found' });
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));

    const sres = await pool.query(
      `SELECT sensor_id, name, zone, status, device_variant,
              battery_voltage, signal_strength, last_ping,
              enzyme_level_percent, cartridge_status, enzyme_capacity_ml,
              enzyme_installed_date, estimated_depletion_date, daily_dispense_ml
         FROM sensors WHERE sensor_id = $1 AND client_id = ANY($2)`, [req.params.sensorId, ids]);
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


// GET /monitoring/sensors/all — ops-wide node fleet with latest reading (ops only)
router.get('/sensors/all', authenticateToken, async (req, res) => {
  const { isClient } = require('../utils/scope');
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  try {
    const { rows } = await pool.query(`
      SELECT s.sensor_id, s.name, s.zone, s.status, s.battery_voltage, s.signal_strength,
             s.last_ping, s.max_capacity, s.latitude, s.longitude,
             s.client_id, s.property_id, s.device_variant, s.firmware_version,
             s.capabilities, s.link_type, s.last_calibrated_at, s.calibration_due_at,
             s.enzyme_level_percent, s.cartridge_status,
             c.name AS client_name,
             r.water_level_percent, r.water_level_liters, r.inflow_rate, r.outflow_rate,
             r.temperature, r.debris_detected, r.silt_depth_mm, r.rainfall_mm,
             r.water_quality_ph, r.turbidity_ntu, r.time AS reading_time,
             cov.assets, cmd.pending_commands
        FROM sensors s
        LEFT JOIN clients c ON c.id = s.client_id
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
        // every asset this node monitors (many-to-many), primary first
        assets: x.assets || [],
        primary_asset: (x.assets || []).find(a => a.is_primary) || null,
        device_variant: x.device_variant, firmware_version: x.firmware_version,
        capabilities: x.capabilities || {}, link_type: x.link_type,
        last_calibrated_at: x.last_calibrated_at, calibration_due_at: x.calibration_due_at,
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
      };
    });
    res.json({ success: true, data });
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
      `SELECT sensor_id, client_id, status FROM sensors WHERE device_key_hash = $1 LIMIT 1`,
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
  const b = req.body || {};
  const sensorId = req.device.sensor_id;              // trust the key, not the body

  // a device may not claim to be a different sensor
  if (b.sensor_id && b.sensor_id !== sensorId) {
    await logIngestError(sensorId, `sensor_id mismatch (claimed ${b.sensor_id})`, b, req.ip);
    return res.status(403).json({ success: false, error: 'Sensor mismatch' });
  }

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

    // hand over any commands queued for this node since its last check-in —
    // store-and-forward: there's no open socket, so "delivery" happens here,
    // piggybacked on the node's own reporting cadence.
    const { rows: pending } = await client.query(
      `UPDATE device_commands SET status = 'delivered', delivered_at = NOW()
        WHERE sensor_id = $1 AND status = 'queued'
        RETURNING id, command_type, payload`, [sensorId]);

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

const VALID_COMMANDS = ['firmware_update', 'reset', 'recalibrate'];

function validateCommandBody(body) {
  if (!VALID_COMMANDS.includes(body.command_type)) {
    return `command_type must be one of: ${VALID_COMMANDS.join(', ')}`;
  }
  if (body.command_type === 'firmware_update' && !(body.payload && body.payload.firmware_version)) {
    return 'firmware_update requires payload.firmware_version';
  }
  return null;
}

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

    const sensorCheck = await pool.query(`SELECT sensor_id FROM sensors WHERE sensor_id = $1`, [req.params.sensorId]);
    if (!sensorCheck.rows.length) return res.status(404).json({ success: false, error: 'Sensor not found' });

    const { rows } = await pool.query(`
      INSERT INTO device_commands (sensor_id, command_type, payload, requested_by, note)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.sensorId, req.body.command_type,
       req.body.payload ? JSON.stringify(req.body.payload) : null,
       req.user.id, req.body.note || null]);

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
    const validIds = valid.map(r => r.sensor_id);
    const skipped = ids.filter(id => !validIds.includes(id));
    if (!validIds.length) return res.status(404).json({ success: false, error: 'None of the given sensors exist' });

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
