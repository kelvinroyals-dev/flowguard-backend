// ─────────────────────────────────────────────────────────────────────────
// clientPermissions.js — RBAC for the CLIENT portal (distinct from ops roles).
//
// A client organisation has four fixed roles. Each maps to a fixed set of
// permission keys (no per-member overrides). The client portal and its backend
// both authorise off these keys so the account owner controls who can do what.
// ─────────────────────────────────────────────────────────────────────────

// All client-portal permission keys.
const CLIENT_PERMISSIONS = [
  'view_dashboard',    // see the account overview
  'view_monitoring',   // live sensor monitoring
  'view_alerts',       // flood/sensor alerts
  'view_reports',      // inspection reports list
  'download_reports',  // download an approved report PDF
  'view_billing',      // see invoices & billing
  'manage_billing',    // report a payment / act on invoices
  'submit_support',    // raise support tickets
  'manage_properties', // add/edit properties, request inspection, choose service
  'manage_team',       // invite/assign/deactivate teammates (sensitive)
  'manage_account',    // account settings & danger zone (sensitive)
];

const ALL = CLIENT_PERMISSIONS.slice();

// role key -> { label, perms }
const CLIENT_ROLES = {
  platform_admin: {
    label: 'Platform admin',
    desc: 'Full control of the account, team and billing.',
    perms: ALL,
  },
  facility_manager: {
    label: 'Facility manager',
    desc: 'Run day-to-day operations: properties, monitoring, alerts, reports and support. No team or billing control.',
    perms: ['view_dashboard','view_monitoring','view_alerts','view_reports','download_reports','view_billing','submit_support','manage_properties'],
  },
  finance: {
    label: 'Finance',
    desc: 'Billing, invoices and payments, plus reports. No operations or team control.',
    perms: ['view_dashboard','view_billing','manage_billing','view_reports','download_reports','submit_support'],
  },
  member: {
    label: 'Member',
    desc: 'Read-only access to monitoring, alerts and reports. Can raise support tickets.',
    perms: ['view_dashboard','view_monitoring','view_alerts','view_reports','download_reports','submit_support'],
  },
};

const CLIENT_ROLE_KEYS = Object.keys(CLIENT_ROLES);

function isValidClientRole(role) { return CLIENT_ROLE_KEYS.includes(String(role || '')); }

// Permission list for a role (unknown role -> read-only member baseline).
function permsForRole(role) {
  const r = CLIENT_ROLES[role] || CLIENT_ROLES.member;
  return r.perms.slice();
}

// Does a client user hold a permission? Non-client users get nothing here (this
// is client-portal RBAC only; ops uses utils/permissions.js).
function clientCan(user, perm) {
  if (!user || user.user_type !== 'client') return false;
  // Owner (account_owner_id null) is always a platform_admin of their org.
  const role = (user.account_owner_id == null) ? 'platform_admin' : (user.client_role || 'member');
  return permsForRole(role).includes(perm);
}

// Express guard factory.
function requireClientPermission(perm) {
  return (req, res, next) => {
    if (clientCan(req.user, perm)) return next();
    return res.status(403).json({ success: false, error: 'You do not have permission to do this.' });
  };
}

// The effective role + permission list for a user (for the FE to gate UI).
function clientRoleInfo(user) {
  const role = (user && user.account_owner_id == null && user.user_type === 'client')
    ? 'platform_admin'
    : (user && user.client_role) || null;
  return {
    client_role: role,
    client_role_label: role && CLIENT_ROLES[role] ? CLIENT_ROLES[role].label : null,
    is_account_owner: !!(user && user.user_type === 'client' && user.account_owner_id == null),
    permissions: role ? permsForRole(role) : [],
  };
}

module.exports = {
  CLIENT_PERMISSIONS, CLIENT_ROLES, CLIENT_ROLE_KEYS,
  isValidClientRole, permsForRole, clientCan, requireClientPermission, clientRoleInfo,
};
