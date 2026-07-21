/* In-app notifications for the client portal. The notifications table + read
   API existed, but nothing ever wrote to it — so the client's bell was always
   empty even though ops replies to tickets, resolves alerts, sends reports /
   invoices and changes property status. This helper is the write side.
   Best-effort: a failed notification must never break the action that triggered it. */
const pool = require('../config/database');

async function notify(userId, opts = {}) {
  if (!userId) return;
  const { type = 'info', title, message = null, link = null } = opts;
  if (!title) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, link, is_read, created_at)
       VALUES ($1,$2,$3,$4,$5,false,NOW())`,
      [userId, title, message, type, link]);
  } catch (e1) {
    // notification_id may be a non-default text PK — retry with a generated id.
    try {
      await pool.query(
        `INSERT INTO notifications (notification_id, user_id, title, message, type, link, is_read, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,false,NOW())`,
        ['NTF-' + Date.now() + '-' + Math.floor(Math.random() * 1000), userId, title, message, type, link]);
    } catch (e2) { console.error('[notify] failed:', e2.message); }
  }
}

// Resolve a client_id (alerts/properties carry this) to the portal user's id.
async function userIdForClient(clientId) {
  if (!clientId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id FROM users u JOIN clients c ON u.email = c.estate_manager_email WHERE c.id = $1 LIMIT 1`,
      [clientId]);
    return rows[0] ? rows[0].id : null;
  } catch (_) { return null; }
}

module.exports = { notify, userIdForClient };
