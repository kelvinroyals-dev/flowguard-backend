// utils/scope.js — per-client data isolation helpers.
// Client-role users must only see their own data; ops roles (admin, etc.) see all.

const pool = require('../config/database');

function isClient(req) {
  return req && req.user && req.user.role === 'client';
}

// The client_id(s) that belong to the logged-in user (via their client record).
// Returns [] if none — callers should treat [] as "no rows" for a client.
async function clientIdsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id
       FROM clients c
       JOIN users u ON u.email = c.estate_manager_email
      WHERE u.id = $1`, [userId]);
  return rows.map(r => r.id);
}

// The property_id(s) owned by the logged-in user.
async function propertyIdsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT property_id FROM properties WHERE user_id = $1`, [userId]);
  return rows.map(r => r.property_id);
}

// The field team_id(s) the user is a member of (team_members link). Used to let
// a field technician act on their OWN team's assignments (status, alert resolve,
// inspection completion) without granting the broad teams.manage/alerts.manage
// permission that ops managers hold.
async function teamIdsForUser(userId) {
  if (!userId) return [];
  // Union both representations: the team_members link table AND the denormalised
  // users.team_id. Members assigned before team_members was kept in sync only
  // have users.team_id, and would otherwise see none of their team's work.
  // Cast to text on both sides: team_members.team_id and users.team_id may be
  // declared with different types, which makes a raw UNION throw. Returning text
  // also lets callers match against string route params consistently.
  const { rows } = await pool.query(
    `SELECT team_id::text AS team_id FROM team_members WHERE user_id = $1
     UNION
     SELECT team_id::text FROM users WHERE id = $1 AND team_id IS NOT NULL`, [userId]);
  return rows.map(r => r.team_id);
}

// ── Service-provider (multi-tenant) device isolation ──────────────────────
// A service-provider user is scoped to devices on the properties assigned to
// their organisation (service_provider_property_assignments). FlowGuard staff
// (no service_provider_org_id) see the whole fleet.
function isSpUser(req) {
  return !!(req && req.user && req.user.service_provider_org_id);
}

// The sensor_ids an SP user may see/act on: sensors on the org's ACTIVE
// property assignments. Returns [] if none.
async function spSensorIds(userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT s.sensor_id
       FROM sensors s
       JOIN service_provider_property_assignments a
         ON a.property_id = s.property_id AND a.active = TRUE
       JOIN users u ON u.id = $1 AND u.service_provider_org_id = a.service_provider_org_id`,
    [userId]);
  return rows.map(r => r.sensor_id);
}

// Device visibility scope for a request:
//   null  → full fleet (FlowGuard staff / ops)
//   [...] → restricted to these sensor_ids (SP tenant; possibly empty)
async function deviceSensorScope(req) {
  if (isSpUser(req)) return await spSensorIds(req.user.id);
  return null;
}

// Is a single sensor within the caller's device scope? Always true for
// full-fleet (non-SP) callers; membership-checked for SP users.
async function sensorInScope(req, sensorId) {
  if (!isSpUser(req)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM sensors s
       JOIN service_provider_property_assignments a
         ON a.property_id = s.property_id AND a.active = TRUE
      WHERE s.sensor_id = $1 AND a.service_provider_org_id = $2 LIMIT 1`,
    [sensorId, req.user.service_provider_org_id]);
  return rows.length > 0;
}

module.exports = {
  isClient, clientIdsForUser, propertyIdsForUser, teamIdsForUser,
  isSpUser, spSensorIds, deviceSensorScope, sensorInScope,
};
