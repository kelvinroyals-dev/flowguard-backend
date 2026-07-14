/* ══════════════════════════════════════════════════════════════
   Incident detection — automation drafts, a human confirms.

   A single high reading is noise. A drain sitting above the critical
   threshold for a sustained window is an event worth a human look.
   This raises a CANDIDATE; it never touches the client-facing
   "days flood-free" counter on its own. An operator confirms or
   dismisses it in the ops portal, and only a confirmation writes a
   flood_incident.

   Getting this wrong in either direction is costly: auto-confirming
   pollutes the client's record with false positives; requiring pure
   manual entry means incidents go unrecorded when everyone is busy
   actually fighting the flood.
   ══════════════════════════════════════════════════════════════ */

const pool = require('../config/database');

const CRITICAL_PCT = 85;      // sustained level that counts as flooding
const SUSTAIN_MIN  = 45;      // must hold for this long
const LOOKBACK_MIN = 180;     // how far back each sweep looks

async function detectIncidents() {
  try {
    // group consecutive above-threshold readings per sensor into breach windows
    const { rows } = await pool.query(`
      WITH recent AS (
        SELECT r.sensor_id, r.time, r.water_level_percent AS lvl, s.property_id
          FROM sensor_readings r
          JOIN sensors s ON s.sensor_id = r.sensor_id
         WHERE r.time > NOW() - ($1 || ' minutes')::interval
           AND r.water_level_percent >= $2
           AND s.property_id IS NOT NULL
      ),
      windows AS (
        SELECT sensor_id, property_id,
               MIN(time) AS breach_start,
               MAX(time) AS breach_end,
               MAX(lvl)  AS peak_level,
               EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) / 60 AS duration_min
          FROM recent
         GROUP BY sensor_id, property_id
      )
      SELECT * FROM windows WHERE duration_min >= $3`,
      [LOOKBACK_MIN, CRITICAL_PCT, SUSTAIN_MIN]);

    let raised = 0;
    for (const w of rows) {
      // the unique (sensor_id, breach_start) index makes this idempotent —
      // a sweep every 15 min won't raise the same breach repeatedly
      const { rowCount } = await pool.query(`
        INSERT INTO incident_candidates
          (property_id, sensor_id, peak_level, breach_start, breach_end, duration_min)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (sensor_id, breach_start) DO UPDATE
          SET breach_end = EXCLUDED.breach_end,
              peak_level = GREATEST(incident_candidates.peak_level, EXCLUDED.peak_level),
              duration_min = EXCLUDED.duration_min
          WHERE incident_candidates.status = 'pending'`,
        [w.property_id, w.sensor_id, w.peak_level, w.breach_start, w.breach_end,
         Math.round(w.duration_min)]);
      if (rowCount) raised++;
    }
    if (raised) console.log(`[incidents] ${raised} candidate(s) raised/updated for review`);
    return raised;
  } catch (err) {
    console.error('[incidents] sweep failed:', err.message);
    return 0;
  }
}

function startIncidentWatch() {
  const run = () => detectIncidents();
  run();                                   // once at boot
  setInterval(run, 15 * 60 * 1000);        // then every 15 minutes
  console.log('[incidents] watch started (sustained ' + CRITICAL_PCT + '% for ' + SUSTAIN_MIN + 'min)');
}

module.exports = { detectIncidents, startIncidentWatch, CRITICAL_PCT, SUSTAIN_MIN };
