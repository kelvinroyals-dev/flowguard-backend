// JWT authentication + role guard
const jwt = require('jsonwebtoken');
const { normalizeRole } = require('../utils/roles');

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); // { id, email, role, user_type }
    // Canonicalise the role so exact-match guards (requireRole) and scope checks
    // never fail just because an account stored its role in a different shape
    // ("Operations Manager", "ops_manager", stray caps). Unknown roles are left
    // untouched, so this never grants access a raw string wouldn't have.
    if (req.user) req.user.role = normalizeRole(req.user.role);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
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
