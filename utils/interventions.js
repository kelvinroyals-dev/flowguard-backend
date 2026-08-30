// utils/interventions.js — does maintenance actually reduce risk?
//
// For each logged intervention (silt clearing, enzyme refill, node repair, etc.)
// we compare what THIS estate's sensors measured in the window BEFORE the event
// against the window AFTER it. Two honest, raw signals: mean water-level % and
// mean silt depth (mm). A drop after the work is the effect we're crediting.
//
// Matching is robust to whether the event was logged on the estate or on a
// specific asset: an event's property_id matches a sensor's asset directly OR
// via that asset's parent estate.
const pool = require('../config/database');

// Interventions we expect to move the needle (exclude pure record events like
// inspection / report_delivered / flood_incident which aren't remediations).
const INTERVENTION_TYPES = ['silt_clearing', 'enzyme_refill', 'maintenance', 'node_repair', 'dispatch', 'incident_prevented'];

// Which raw signal is the headline "win" for each intervention type.
const PRIMARY_METRIC = {
  silt_clearing: 'silt', maintenance: 'silt', dispatch: 'silt', node_repair: 'water_level',
  enzyme_refill: 'water_level', incident_prevented: 'water_level',
};

const round1 = v => v == null ? null : Math.round(v * 10) / 10;

// Per-event before/after means over a symmetric window (default 7 days each side).
async function eventEffects({ days = 180, windowDays = 7 } = {}) {
  const { rows } = await pool.query(
    `WITH ev AS (
       SELECT e.id, e.property_id, e.event_type, e.occurred_at
         FROM property_events e
        WHERE e.event_type = ANY($1)
          AND e.occurred_at >= NOW() - ($2 || ' days')::interval
          AND e.occurred_at <= NOW() - ($3 || ' days')::interval   -- leave room for an 'after' window
     )
     SELECT ev.id, ev.event_type, ev.property_id, ev.occurred_at,
            COALESCE(pe.property_name, e2.property_name) AS estate_name,
            AVG(r.water_level_percent) FILTER (WHERE r.time <  ev.occurred_at) AS wl_before,
            AVG(r.water_level_percent) FILTER (WHERE r.time >= ev.occurred_at) AS wl_after,
            AVG(r.silt_depth_mm)       FILTER (WHERE r.time <  ev.occurred_at) AS silt_before,
            AVG(r.silt_depth_mm)       FILTER (WHERE r.time >= ev.occurred_at) AS silt_after,
            COUNT(r.*) FILTER (WHERE r.time <  ev.occurred_at) AS n_before,
            COUNT(r.*) FILTER (WHERE r.time >= ev.occurred_at) AS n_after
       FROM ev
       JOIN properties asset
         ON ev.property_id IN (asset.property_id, asset.parent_property_id)
       JOIN sensors s ON s.property_id = asset.property_id
       JOIN sensor_readings r
         ON r.sensor_id = s.sensor_id
        AND r.time >= ev.occurred_at - ($4 || ' days')::interval
        AND r.time <  ev.occurred_at + ($4 || ' days')::interval
       LEFT JOIN properties pe ON pe.property_id = ev.property_id
       LEFT JOIN properties e2 ON e2.property_id = asset.parent_property_id
      GROUP BY ev.id, ev.event_type, ev.property_id, ev.occurred_at, pe.property_name, e2.property_name`,
    [INTERVENTION_TYPES, String(days), '1', String(windowDays)]);

  return rows.map(r => {
    const wl_before = r.wl_before != null ? Number(r.wl_before) : null;
    const wl_after = r.wl_after != null ? Number(r.wl_after) : null;
    const silt_before = r.silt_before != null ? Number(r.silt_before) : null;
    const silt_after = r.silt_after != null ? Number(r.silt_after) : null;
    return {
      id: r.id, event_type: r.event_type, property_id: r.property_id,
      estate_name: r.estate_name || r.property_id, occurred_at: r.occurred_at,
      n_before: Number(r.n_before), n_after: Number(r.n_after),
      water_level: { before: round1(wl_before), after: round1(wl_after), delta: (wl_before != null && wl_after != null) ? round1(wl_after - wl_before) : null },
      silt: { before: round1(silt_before), after: round1(silt_after), delta: (silt_before != null && silt_after != null) ? round1(silt_after - silt_before) : null },
    };
  });
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// Roll per-event deltas up into a per-type summary + overall headline.
async function computeInterventionEffects(opts = {}) {
  const events = await eventEffects(opts);
  const byType = {};
  for (const t of INTERVENTION_TYPES) byType[t] = [];
  for (const e of events) (byType[e.event_type] = byType[e.event_type] || []).push(e);

  const summary = INTERVENTION_TYPES.map(type => {
    const evs = byType[type] || [];
    const wlDeltas = evs.map(e => e.water_level.delta).filter(v => v != null);
    const siltDeltas = evs.map(e => e.silt.delta).filter(v => v != null);
    const primary = PRIMARY_METRIC[type] || 'silt';
    const primDeltas = primary === 'silt' ? siltDeltas : wlDeltas;
    const improved = primDeltas.filter(v => v < 0).length;   // a drop is the win
    return {
      event_type: type,
      primary_metric: primary,
      count: evs.length,
      measured: primDeltas.length,
      avg_water_level_delta: round1(mean(wlDeltas)),
      avg_silt_delta: round1(mean(siltDeltas)),
      avg_primary_delta: round1(mean(primDeltas)),
      improved_pct: primDeltas.length ? Math.round((improved / primDeltas.length) * 100) : null,
    };
  }).filter(s => s.count > 0);

  const allPrimary = summary.flatMap(s => (byType[s.event_type] || [])
    .map(e => (s.primary_metric === 'silt' ? e.silt.delta : e.water_level.delta))
    .filter(v => v != null));

  return {
    window_days: opts.windowDays || 7,
    lookback_days: opts.days || 180,
    total_interventions: events.length,
    total_measured: allPrimary.length,
    avg_primary_delta: round1(mean(allPrimary)),
    improved_pct: allPrimary.length ? Math.round((allPrimary.filter(v => v < 0).length / allPrimary.length) * 100) : null,
    by_type: summary,
    recent: events.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, 30),
    note: 'Before/after = mean of each estate\'s sensor readings in the window on either side of the intervention. A negative delta (level or silt going down) is the improvement.',
  };
}

module.exports = { computeInterventionEffects, INTERVENTION_TYPES, PRIMARY_METRIC };
