// Authentication routes: login, register
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, user_type: user.user_type },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// A dedicated, purpose-scoped, short-lived token for the email-verification
// link. This must NOT be signToken() — that issues a full 7-day session
// credential, and the verification link goes out over plain email (mail
// server logs, forwarding, link-scanning proxies, browser history). Scoping
// it to `purpose: 'email_verify'` with a short expiry means a leaked link
// is only ever good for verifying that one email, for a few hours.
function signVerifyToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, purpose: 'email_verify' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// Shape the user object the frontend expects (both fullName and full_name)
function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    user_type: u.user_type,
    fullName: u.full_name,
    full_name: u.full_name,
    phone: u.phone,
    client_id: u.client_id,
  };
}


// Reset tokens are stored HASHED. Previously the same token that was
// emailed was written raw to users.reset_token — anyone who could read
// that table (leaked backup, rogue admin, any future read primitive)
// could take over every account by replaying it.
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// Brute-force protection
const MAX_ATTEMPTS = 8;
const LOCK_MINUTES = 20;

async function logAuth(email, event, req) {
  try {
    await pool.query(
      `INSERT INTO auth_events (email, event, ip, user_agent) VALUES ($1,$2,$3,$4)`,
      [email || null, event, req.ip || null, (req.get('user-agent') || '').slice(0, 300)]);
  } catch (_) { /* auditing must never break auth */ }
}

// A dummy hash so a login attempt for a NON-EXISTENT user still costs the
// same bcrypt work as a real one. Without this, the response time reveals
// which emails are registered — user enumeration despite identical errors.
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// POST /api/v1/auth/login   body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    const addr = email.toLowerCase().trim();
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [addr]);
    const user = rows[0];

    // locked out?
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      await logAuth(addr, 'locked', req);
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(429).json({
        success: false,
        error: `Account temporarily locked after repeated failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    // ALWAYS run bcrypt — even for an unknown email — so the response time
    // does not reveal whether the account exists.
    const ok = await bcrypt.compare(password, (user && user.password_hash) || DUMMY_HASH);

    if (!user || !user.is_active || !ok) {
      if (user) {
        const attempts = (user.failed_attempts || 0) + 1;
        const lock = attempts >= MAX_ATTEMPTS;
        await pool.query(
          `UPDATE users SET failed_attempts = $2, last_failed_at = NOW(),
                  locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' minutes')::interval ELSE locked_until END
            WHERE id = $1`,
          [user.id, lock ? 0 : attempts, lock, LOCK_MINUTES]);
        if (lock) await logAuth(addr, 'locked', req);
      }
      await logAuth(addr, 'login_failed', req);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    await pool.query(
      'UPDATE users SET last_login = NOW(), failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [user.id]);
    await logAuth(addr, 'login_success', req);
    const token = signToken(user);
    return res.json({ success: true, data: { token, user: publicUser(user) } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /api/v1/auth/register
// body: { firstName, lastName, email, phone, company, location, plan, password, marketing }
router.post('/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { firstName, lastName, email, phone, password, company, location, plan, marketing } = req.body || {};
    if (!email || !password || !firstName) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    const hash = await bcrypt.hash(password, 10);

    // map the signup corridor dropdown to city / state
    const CORRIDORS = {
      'lekki-ajah':     { area: 'Lekki / Ajah Corridor',   city: 'Lekki',  state: 'Lagos' },
      'ikoyi-vi':       { area: 'Ikoyi / Victoria Island', city: 'Ikoyi',  state: 'Lagos' },
      'ikeja-maryland': { area: 'Ikeja GRA / Maryland',    city: 'Ikeja',  state: 'Lagos' },
      'other-lagos':    { area: 'Other Lagos',             city: 'Lagos',  state: 'Lagos' },
      'outside-lagos':  { area: 'Outside Lagos',           city: 'Unspecified', state: 'Unspecified' },
    };
    const corridor = CORRIDORS[location] || { area: location || 'Unspecified', city: 'Unspecified', state: 'Unspecified' };

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, role, user_type, full_name, phone, is_active, email_verified)
       VALUES ($1, $2, 'client', 'client', $3, $4, true, false)
       RETURNING *`,
      [cleanEmail, hash, fullName, phone || null]
    );
    const user = rows[0];

    // Seed onboarding preferences so demo mode + the guided tour work on ANY
    // device the new client signs in from (not just the browser they signed up
    // in). show_demo_data starts on; onboarding_completed flips once they finish
    // the tour, and the portal turns demo off once they have real properties.
    try {
      await client.query(
        `INSERT INTO user_preferences (user_id, show_demo_data, onboarding_completed)
         VALUES ($1, true, false) ON CONFLICT (user_id) DO NOTHING`, [user.id]);
    } catch (_) { /* non-blocking — localStorage still drives same-device onboarding */ }

    // create the property the user submitted at signup (previously dropped on the floor)
    if (company && company.trim()) {
      const propertyId = 'PROP-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random()*1000);
      const meta = { corridor: location || null, service_tier_interest: plan || null, marketing_opt_in: !!marketing };
      await client.query(
        `INSERT INTO properties
           (property_id, user_id, property_name, property_type, address_line1, city, state, country,
            contact_person_name, contact_phone, contact_email, current_issues, status)
         VALUES ($1,$2,$3,'residential_estate',$4,$5,$6,'Nigeria',$7,$8,$9,$10,'submitted')`,
        [
          propertyId, user.id, company.trim(),
          corridor.area, corridor.city, corridor.state,
          fullName, phone || null, cleanEmail,
          JSON.stringify(meta),
        ]
      );
    }

    await client.query('COMMIT');

    const token = signToken(user);

    // Fire-and-forget emails (never block or fail the signup response)
    (async () => {
      try {
        const mailer = require('../utils/mailer');
        await mailer.sendWelcome(user.email, user.full_name);
        // email verification link — purpose-scoped, 24h token (not a full login session)
        const verifyToken = signVerifyToken(user);
        const verifyUrl = `https://app.flowguard.ng/verify-email.html?token=${verifyToken}`;
        await mailer.sendVerification(user.email, verifyUrl);
        await mailer.sendOpsNewSignup(user);
        if (company && company.trim()) {
          await mailer.sendPropertyReceived(user.email, user.full_name, company.trim(), propertyId);
          await mailer.sendOpsNewProperty({ property_name: company.trim(), city: corridor.city, state: corridor.state }, user.full_name);
        }
      } catch (e) { console.error('[register] email dispatch error:', e.message); }
    })();

    return res.status(201).json({ success: true, data: { token, user: publicUser(user) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Register error:', err);
    return res.status(500).json({ success: false, error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// GET /api/v1/auth/me  (verify token, return current user)
const { authenticateToken } = require('../middleware/auth');
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: { user: publicUser(rows[0]) } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// POST /api/v1/auth/forgot-password  (request a reset link)
router.post('/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    // Always respond the same way, whether or not the email exists,
    // so attackers can't probe which emails are registered.
    const generic = { success: true, message: 'If an account exists for that email, a reset link has been sent.' };
    if (!email) return res.json(generic);

    const { rows } = await pool.query('SELECT id, email FROM users WHERE LOWER(email) = $1 AND is_active = true', [email]);
    if (!rows[0]) return res.json(generic);

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3', [hashToken(token), expires, rows[0].id]);
    await logAuth(rows[0].email, 'reset_requested', req);

    const resetUrl = `https://app.flowguard.ng/reset-password.html?token=${token}`;
    // Email delivery is handled by the mail layer (SendGrid). Until that's wired,
    // the token is stored and the link is logged server-side so the flow is testable.
    console.log(`[forgot-password] reset link for ${email}: ${resetUrl}`);
    try {
      const { sendPasswordReset } = require('../utils/mailer');
      if (typeof sendPasswordReset === 'function') await sendPasswordReset(email, resetUrl);
    } catch (mailErr) {
      console.warn('[forgot-password] mailer not available yet:', mailErr.message);
    }
    return res.json(generic);
  } catch (err) {
    console.error('POST /auth/forgot-password', err);
    // Still return generic success to avoid leaking internal errors/enumeration
    return res.json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
  }
});

// POST /api/v1/auth/reset-password  (set a new password using a valid token)
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ success: false, error: 'Token and new password are required.' });
    if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });

    const { rows } = await pool.query(
      'SELECT id, email, full_name FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()', [hashToken(token)]);
    if (!rows[0]) return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired.' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hash, rows[0].id]);

    // security confirmation email (fire-and-forget)
    (async () => {
      try {
        const mailer = require('../utils/mailer');
        await mailer.sendPasswordChanged(rows[0].email, rows[0].full_name);
      } catch (e) { console.error('[reset-password] email error:', e.message); }
    })();

    return res.json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    console.error('POST /auth/reset-password', err);
    return res.status(500).json({ success: false, error: 'Failed to reset password.' });
  }
});

// POST /api/v1/auth/verify-email  (mark account email as verified)
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Verification token is required.' });
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(400).json({ success: false, error: 'This verification link is invalid or has expired.' });
    }
    // Reject any other token type (e.g. a normal 7-day login token) — this
    // link must only ever be usable for the one thing it was issued for.
    if (payload.purpose !== 'email_verify') {
      return res.status(400).json({ success: false, error: 'This verification link is invalid or has expired.' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET email_verified = true WHERE id = $1 RETURNING id, email, email_verified',
      [payload.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Account not found.' });
    return res.json({ success: true, message: 'Your email has been verified.', data: { email: rows[0].email } });
  } catch (err) {
    console.error('POST /auth/verify-email', err);
    return res.status(500).json({ success: false, error: 'Verification failed.' });
  }
});

module.exports = router;
