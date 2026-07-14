// utils/audit.js — fire-and-forget action logging for the activity stream.
const pool = require('../config/database');

function logAction(userId, action, entityType, entityId, changes) {
  pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, changes)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, action, entityType || null, entityId || null, changes ? JSON.stringify(changes) : null]
  ).catch(err => console.error('[audit]', err.message));
}

module.exports = { logAction };
