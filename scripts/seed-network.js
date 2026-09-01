#!/usr/bin/env node
/* seed-network.js — give the digital twin something to render, honestly.
 *
 * Inserts real Lagos water bodies (Lagos Lagoon, a demo canal) and, for each
 * estate's drainage assets, infers a plausible downstream chain + zone +
 * estimated dimensions. EVERYTHING inferred is marked *_verified = false so the
 * UI shows "topology / dimensions estimated" rather than pretending it's surveyed.
 *
 * Safe to re-run. Only fills gaps (won't overwrite verified data).
 *   node scripts/seed-network.js
 */
require('dotenv').config();
const pool = require('../config/database');

// Type → rank in the flow (low collects into high; highest reaches the outfall).
const RANK = {
  catch_basin: 1, manhole: 1, storm_drain: 2, secondary_drain: 2,
  box_culvert: 3, retention_pond: 3, detention_tank: 3,
  primary_canal: 4, pump_station: 4, overflow_chamber: 4, flood_gate: 4,
  outfall: 5,
};
const DIMS = { // estimated length/width/depth (m) + material by type
  catch_basin:    { l: 3,   w: 1.2, d: 1.5, m: 'Concrete' },
  manhole:        { l: 2,   w: 1,   d: 2,   m: 'Concrete' },
  storm_drain:    { l: 120, w: 0.8, d: 1,   m: 'Concrete' },
  secondary_drain:{ l: 240, w: 1.2, d: 1.4, m: 'Concrete' },
  box_culvert:    { l: 30,  w: 2,   d: 2,   m: 'Reinforced concrete' },
  primary_canal:  { l: 900, w: 4,   d: 3,   m: 'Concrete-lined' },
  pump_station:   { l: 12,  w: 8,   d: 4,   m: 'Concrete' },
  outfall:        { l: 20,  w: 3,   d: 3,   m: 'Reinforced concrete' },
};

async function main() {
  // 1) Water bodies (real environmental facts for Lagos).
  await pool.query(`
    INSERT INTO water_bodies (water_body_id, name, type, status, capacity_pct, condition, latitude, longitude)
    VALUES
      ('WB-LAGOON', 'Lagos Lagoon', 'lagoon', 'normal', 68, 'good', 6.4550, 3.4200),
      ('WB-CANAL-C08', 'Canal C-08', 'canal', 'normal', 74, 'fair', 6.4380, 3.4550)
    ON CONFLICT (water_body_id) DO NOTHING`);
  await pool.query(`UPDATE water_bodies SET downstream_water_body_id='WB-LAGOON'
     WHERE water_body_id='WB-CANAL-C08' AND downstream_water_body_id IS NULL`);

  // 2) Per-estate topology + zone + estimated dimensions.
  const { rows: estates } = await pool.query(
    `SELECT property_id, property_name, city, state FROM properties
      WHERE (asset_class='customer_property' OR asset_class IS NULL) AND parent_property_id IS NULL`);

  let chained = 0, dimd = 0, zoned = 0;
  for (const est of estates) {
    const zone = est.city || est.state || 'Unzoned';
    // Estate's drainage assets.
    const { rows: assets } = await pool.query(
      `SELECT property_id, property_type, downstream_asset_id, topology_verified, dimensions_verified, zone
         FROM properties WHERE asset_class='drainage_asset' AND parent_property_id=$1`, [est.property_id]);
    // Zone the estate itself.
    await pool.query(`UPDATE properties SET zone=COALESCE(zone,$2) WHERE property_id=$1`, [est.property_id, zone]);

    // Estimated dimensions + zone for each asset (only where missing).
    for (const a of assets) {
      const d = DIMS[a.property_type];
      if (d && !a.dimensions_verified) {
        await pool.query(
          `UPDATE properties SET length_m=COALESCE(length_m,$2), width_m=COALESCE(width_m,$3),
             depth_m=COALESCE(depth_m,$4), material=COALESCE(material,$5),
             flow_direction=COALESCE(flow_direction,'downstream'), dimensions_verified=false
           WHERE property_id=$1`, [a.property_id, d.l, d.w, d.d, d.m]);
        dimd++;
      }
      await pool.query(`UPDATE properties SET zone=COALESCE(zone,$2) WHERE property_id=$1`, [a.property_id, zone]);
      zoned++;
    }

    // Chain: sort by rank; each asset drains into the next higher-ranked one.
    const sorted = assets.slice().sort((x, y) => (RANK[x.property_type] || 2) - (RANK[y.property_type] || 2));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (a.topology_verified || a.downstream_asset_id) continue;
      const next = sorted.slice(i + 1).find(z => (RANK[z.property_type] || 2) > (RANK[a.property_type] || 2));
      if (next) {
        await pool.query(`UPDATE properties SET downstream_asset_id=$2 WHERE property_id=$1`, [a.property_id, next.property_id]);
        chained++;
      } else if (a.property_type === 'outfall') {
        await pool.query(`UPDATE properties SET water_body_id=COALESCE(water_body_id,'WB-LAGOON') WHERE property_id=$1`, [a.property_id]);
      }
    }
    // Estate (customer property) connects to its lowest-rank drain (its collector).
    if (sorted.length) {
      await pool.query(`UPDATE properties SET downstream_asset_id=COALESCE(downstream_asset_id,$2) WHERE property_id=$1`,
        [est.property_id, sorted[0].property_id]);
    }
  }

  console.log(`seed-network: water bodies ready · chained ${chained} assets · dimensions on ${dimd} · zoned ${zoned} (all marked unverified)`);
  await pool.end();
}

main().catch(async e => { console.error(e); try { await pool.end(); } catch (_) {} process.exit(1); });
