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
  // Canonicalise the role so exact-match guards (requireRole) and scope checks
  // never fail just because an account stored its role in a different shape.
  payload.role = normalizeRole(payload.role);
  req.user = payload;

  // Live session check: reject a token whose account has since been deactivated,
  // or whose sessions were invalidated (password reset / "sign out everywhere")
  // after this token was issued — stateless JWTs cannot otherwise be revoked.
  // FAIL OPEN on any DB/setup error (including before the token_version column
  // migration is applied) so an infra hiccup can never lock every user out.
  try {
    const { rows } = await pool.query('SELECT is_active, token_version FROM users WHERE id = $1', [payload.id]);
    const u = rows[0];
    if (!u || u.is_active === false || (u.token_version || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
    }
  } catch (_) { /* fail open — never lock everyone out on a DB/migration hiccup */ }

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
