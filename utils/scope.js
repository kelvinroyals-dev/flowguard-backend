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
  const { rows } = await pool.query(
    `SELECT team_id FROM team_members WHERE user_id = $1`, [userId]);
  return rows.map(r => r.team_id);
}

module.exports = { isClient, clientIdsForUser, propertyIdsForUser, teamIdsForUser };
