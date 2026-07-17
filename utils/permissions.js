/* ════════════════════════════════════════════════════════════════
   Role-based permissions — editable, persisted, enforced.

   • CATALOG   — every module × action a role can be granted.
   • DEFAULTS  — the built-in grant per role (matches the app's prior
                 hardcoded behaviour, so nothing changes until edited).
   • overrides — rows in role_permissions flip a default on/off.

   hasPermission(role,key) = admin/super_admin ⇒ true; else the override
   if one exists, else the default. Absence of data is always safe.
   ════════════════════════════════════════════════════════════════ */
const pool = require('../config/database');

// Modules map 1:1 to nav tabs; each has view (see it) + manage (change it).
const MODULES = [
  { key: 'situation',     label: 'Situation' },
  { key: 'network',       label: 'Network' },
  { key: 'properties',    label: 'Properties' },
  { key: 'clients',       label: 'Clients' },
  { key: 'billing',       label: 'Billing' },
  { key: 'assets',        label: 'Assets' },
  { key: 'devices',       label: 'Devices' },
  { key: 'alerts',        label: 'Alerts' },
  { key: 'maintenance',   label: 'Maintenance' },
  { key: 'reports',       label: 'Reports' },
  { key: 'teams',         label: 'Teams' },
  { key: 'team-members',  label: 'Team Members' },
  { key: 'field-reports', label: 'Field Reports' },
  { key: 'forecast',      label: 'AI Forecast' },
  { key: 'audit',         label: 'Audit Log' },
  { key: 'administration',label: 'Administration' },
];
const ACTIONS = ['view', 'manage'];
const ALL_KEYS = [];
MODULES.forEach(m => ACTIONS.forEach(a => ALL_KEYS.push(`${m.key}.${a}`)));

const ADMIN_ROLES = ['admin', 'super_admin'];

// Built-in defaults (view list, manage list) per role. '*' = all modules.
const ROLE_DEFAULTS = {
  operations_manager: {
    view: '*',
    manage: ['network', 'properties', 'clients', 'billing', 'assets', 'devices', 'alerts', 'maintenance', 'teams', 'team-members', 'field-reports', 'forecast', 'reports'],
  },
  dispatcher: {
    view: ['situation', 'network', 'properties', 'assets', 'devices', 'alerts', 'maintenance', 'teams', 'field-reports', 'forecast'],
    manage: ['alerts', 'maintenance'],
  },
  field_lead: {
    view: ['situation', 'maintenance', 'field-reports', 'assets', 'alerts'],
    manage: ['field-reports'],
  },
  analyst: {
    view: ['situation', 'reports', 'forecast', 'clients', 'properties', 'billing', 'alerts', 'network'],
    manage: ['reports'],
  },
  finance: {
    view: ['situation', 'clients', 'properties', 'billing', 'reports'],
    manage: ['billing'],
  },
};

function defaultAllowed(role, key) {
  if (ADMIN_ROLES.includes(role)) return true;
  const [mod, action] = key.split('.');
  const d = ROLE_DEFAULTS[role];
  if (!d) return key === 'situation.view';  // unknown role: minimal
  const inList = (list) => list === '*' || (Array.isArray(list) && list.includes(mod));
  if (action === 'view') return inList(d.view) || inList(d.manage);  // manage implies view
  if (action === 'manage') return inList(d.manage);
  return false;
}

// ── override cache (in-memory, invalidated on save) ──
let _cache = null;   // Map "role|key" -> boolean
async function ensureLoaded() {
  if (_cache) return _cache;
  _cache = new Map();
  try {
    const { rows } = await pool.query('SELECT role, permission_key, allowed FROM role_permissions');
    rows.forEach(r => _cache.set(`${r.role}|${r.permission_key}`, r.allowed));
  } catch (e) { /* table may not exist yet — defaults still apply */ }
  return _cache;
}
function invalidate() { _cache = null; }

async function hasPermission(role, key) {
  if (ADMIN_ROLES.includes(role)) return true;
  const cache = await ensureLoaded();
  const o = cache.get(`${role}|${key}`);
  return (o === undefined) ? defaultAllowed(role, key) : o;
}

// Effective permission set for a role (all catalog keys → boolean).
async function effective(role) {
  const cache = await ensureLoaded();
  const out = {};
  for (const key of ALL_KEYS) {
    if (ADMIN_ROLES.includes(role)) { out[key] = true; continue; }
    const o = cache.get(`${role}|${key}`);
    out[key] = (o === undefined) ? defaultAllowed(role, key) : o;
  }
  return out;
}

// Full matrix for the editor: catalog + every non-admin role's effective values.
async function matrix() {
  const roles = Object.keys(ROLE_DEFAULTS);   // editable roles (admins are always-all)
  const grants = {};
  for (const role of roles) grants[role] = await effective(role);
  return { modules: MODULES, actions: ACTIONS, roles, admin_roles: ADMIN_ROLES, grants };
}

// Save overrides. `changes` = [{ role, permission_key, allowed }]. Admin roles
// can't be edited (always full). Writing allowed === default removes the row.
async function saveOverrides(changes) {
  if (!Array.isArray(changes)) return;
  for (const c of changes) {
    if (!c || !c.role || !c.permission_key || ADMIN_ROLES.includes(c.role)) continue;
    if (!ALL_KEYS.includes(c.permission_key) || !ROLE_DEFAULTS[c.role]) continue;
    const allowed = !!c.allowed;
    if (allowed === defaultAllowed(c.role, c.permission_key)) {
      await pool.query('DELETE FROM role_permissions WHERE role=$1 AND permission_key=$2', [c.role, c.permission_key]);
    } else {
      await pool.query(
        `INSERT INTO role_permissions (role, permission_key, allowed, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (role, permission_key) DO UPDATE SET allowed=EXCLUDED.allowed, updated_at=NOW()`,
        [c.role, c.permission_key, allowed]);
    }
  }
  invalidate();
}

// Express middleware — 403 unless the caller's role has `key`.
function requirePermission(key) {
  return async (req, res, next) => {
    try {
      if (req.user && await hasPermission(req.user.role, key)) return next();
      return res.status(403).json({ success: false, error: 'You do not have permission for this action.' });
    } catch (e) {
      console.error('[permissions] check failed:', e.message);
      return res.status(500).json({ success: false, error: 'Permission check failed' });
    }
  };
}

module.exports = { MODULES, ACTIONS, ALL_KEYS, ADMIN_ROLES, hasPermission, effective, matrix, saveOverrides, requirePermission, invalidate };
