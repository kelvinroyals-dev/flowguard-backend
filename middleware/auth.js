// JWT authentication + role guard
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { normalizeRole } = require('../utils/roles');

async function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'No token provided' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); // { id, email, role, user_type, tv }
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
  // Verification/evidence/report-link tokens share the signer but are NOT
  // login sessions. Never upgrade one into a session by reading its account.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.prototype.hasOwnProperty.call(payload, 'purpose') ||
      !['number','string'].includes(typeof payload.id) ||
      !/^\d+$/.test(String(payload.id)) || !Number.isSafeInteger(Number(payload.id)) || Number(payload.id) <= 0) {
    return res.status(401).json({ success: false, error: 'A valid sign-in session is required.' });
  }
  // Canonicalise the role so exact-match guards (requireRole) and scope checks
  // never fail just because an account stored its role in a different shape.
  payload.role = normalizeRole(payload.role);
  req.user = payload;

  // Live session check: reject a token whose account has since been deactivated,
  // or whose sessions were invalidated (password reset / "sign out everywhere")
  // after this token was issued — stateless JWTs cannot otherwise be revoked.
  // Authorization cannot be established during a DB/schema failure. Return a
  // retryable 503 instead of silently accepting a possibly revoked session.
  try {
    const { rows } = await pool.query('SELECT id, email, role, user_type, is_active, token_version, service_provider_org_id, sp_role FROM users WHERE id = $1', [payload.id]);
    const u = rows[0];
    if (!u || u.is_active === false || (u.token_version || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
    }
    // A signed token is proof of identity, not a permanent role grant. Staff
    // demotion/account-type changes apply on the very next REST request.
    req.user = { ...payload, id: u.id, email: u.email, role: normalizeRole(u.role), user_type: u.user_type,
      spo: u.service_provider_org_id || null, service_provider_org_id: u.service_provider_org_id || null,
      sp_role: u.sp_role || null };
  } catch (_) {
    console.error('[auth] Live session validation unavailable');
    return res.status(503).json({ success: false, error: 'Authentication is temporarily unavailable. Please retry.' });
  }

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticateToken, requireRole };
