#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   FlowGuard — demo telemetry seeder
   Generates plausible 30-day history for every registered sensor,
   writing to the SAME sensor_readings table the real Sentinel nodes
   will post to. Nothing here is throwaway: when hardware ships,
   stop running this and real readings simply continue the series.

   Usage:
     node scripts/seed-telemetry.js                # 30 days, 15-min cadence
     node scripts/seed-telemetry.js --days 7
     node scripts/seed-telemetry.js --wipe         # clear existing first
     node scripts/seed-telemetry.js --live         # append one reading now
                                                   #   (cron this every 15m)
   ══════════════════════════════════════════════════════════════ */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      }
);

const args = process.argv.slice(2);
const DAYS = parseInt((args.find(a => a.startsWith('--days')) || '').split('=')[1] ||
  (args.includes('--days') ? args[args.indexOf('--days') + 1] : 0)) || 30;
const WIPE = args.includes('--wipe');
const LIVE = args.includes('--live');
const STEP_MIN = 15;

/* ── Lagos rainfall: wet season, afternoon-weighted convective storms ── */
function rainfallAt(t) {
  const day = Math.floor(t / 864e5);
  // a storm every ~4 days, biased to afternoon
  const stormDay = (day * 2654435761 % 4) === 0;
  const hr = new Date(t).getHours();
  if (!stormDay) return hr >= 14 && hr <= 17 && (day % 2 === 0) ? 0.4 : 0;
  const peak = 15;                                   // 15:00 peak
  const spread = 3.2;
  const intensity = Math.exp(-Math.pow(hr - peak, 2) / (2 * spread * spread));
  return intensity * 9;                              // up to ~9 mm/h at peak
}

/* ── each node has its own character ── */
const PROFILE = {
  // baseline level %, responsiveness to rain, drain rate, silt tendency
  default: { base: 22, gain: 1.55, drain: 0.86, noise: 1.6 },
};
function profileFor(sensor, i) {
  const p = { ...PROFILE.default };
  p.base += (i % 3) * 6;                 // 22 / 28 / 34
  p.gain += (i % 2) * 0.45;
  p.drain -= (i % 3) * 0.04;             // some drains clear slower (siltier)
  return p;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function main() {
  const { rows: sensors } = await pool.query(
    `SELECT sensor_id, name, max_capacity FROM sensors ORDER BY sensor_id`);
  if (!sensors.length) {
    console.error('No sensors registered — nothing to seed.');
    process.exit(1);
  }
  console.log(`Seeding ${sensors.length} sensor(s): ${sensors.map(s => s.sensor_id).join(', ')}`);

  if (WIPE) {
    const { rowCount } = await pool.query('DELETE FROM sensor_readings');
    console.log(`Wiped ${rowCount} existing readings.`);
  }

  const now = Date.now();
  const startMs = LIVE ? now : now - DAYS * 864e5;
  const endMs = now;

  for (const [i, s] of sensors.entries()) {
    const p = profileFor(s, i);
    const cap = s.max_capacity || 5000;
    let level = p.base;
    let batteryV = 4.05 - (i * 0.06);        // each node starts a little different
    const rows = [];

    for (let t = startMs; t <= endMs; t += STEP_MIN * 60e3) {
      const mm = rainfallAt(t);

      // water level: rises with rain, recedes exponentially, tidal wobble near the lagoon
      const tide = Math.sin((t / 36e5) * (2 * Math.PI / 12.4)) * 2.4;   // ~12.4h semi-diurnal
      // decays toward the drain's resting baseline, not to zero
      level = p.base * (1 - p.drain) + level * p.drain + mm * p.gain + tide * 0.35 + (Math.random() - 0.5) * p.noise;
      level = clamp(level, 3, 97);

      // flow follows level and rain; outflow lags inflow when the drain is loaded
      const inflow  = clamp(mm * 2.4 + level * 0.06 + Math.random() * 0.4, 0, 60);
      const outflow = clamp(inflow * (level > 70 ? 0.62 : 0.9) + Math.random() * 0.3, 0, 60);

      // debris: more likely when the drain has been running high
      const debris = level > 72 && Math.random() < 0.06;

      // battery: solar-ish daily recovery, slow net drain, worse in the rain
      const hr = new Date(t).getHours();
      const solar = (hr >= 8 && hr <= 16 && mm < 1) ? 0.0055 : 0;
      batteryV = clamp(batteryV + solar - 0.0016 - (mm > 3 ? 0.0006 : 0), 3.35, 4.2);

      const signal = Math.round(clamp(74 - (mm > 4 ? 12 : 0) + (Math.random() - 0.5) * 10, 25, 96));
      const temp = +(26.5 + Math.sin((hr - 6) / 24 * 2 * Math.PI) * 3.4 - (mm > 2 ? 1.8 : 0)
                     + (Math.random() - 0.5)).toFixed(1);

      rows.push([
        s.sensor_id, new Date(t),
        +level.toFixed(2),
        Math.round(cap * level / 100),
        +inflow.toFixed(2), +outflow.toFixed(2),
        temp, debris,
      ]);
    }

    // bulk insert in chunks; idempotent thanks to the unique (sensor_id, time) index
    const CHUNK = 500;
    for (let c = 0; c < rows.length; c += CHUNK) {
      const slice = rows.slice(c, c + CHUNK);
      const vals = [];
      const ph = slice.map((r, k) => {
        const o = k * 8;
        vals.push(...r);
        return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8})`;
      }).join(',');
      await pool.query(
        `INSERT INTO sensor_readings
           (sensor_id, time, water_level_percent, water_level_liters,
            inflow_rate, outflow_rate, temperature, debris_detected)
         VALUES ${ph}
         ON CONFLICT (sensor_id, time) DO NOTHING`, vals);
    }

    // node vitals, matching the last generated reading
    const last = rows[rows.length - 1];
    await pool.query(
      `UPDATE sensors SET last_ping = $2, battery_voltage = $3,
              signal_strength = $4, firmware_version = COALESCE(firmware_version, 'sim-1.0.0'),
              updated_at = NOW()
         WHERE sensor_id = $1`,
      [s.sensor_id, last[1], +batteryV.toFixed(2),
       Math.round(clamp(70 + (Math.random() - .5) * 20, 30, 95))]);

    console.log(`  ${s.sensor_id.padEnd(10)} ${rows.length} readings  ` +
                `level ${last[2]}%  flow ${last[4]} L/s  batt ${batteryV.toFixed(2)}V`);
  }

  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM sensor_readings');
  console.log(`\nDone. sensor_readings now holds ${count} rows.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
