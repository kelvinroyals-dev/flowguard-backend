// utils/roles.js — canonical internal role keys + role-string normalisation.
//
// Single source of truth shared by the auth middleware (which canonicalises the
// role on every request) and the staff-invite validator. Keep the ops frontend
// aligned: flowguard-operations/js/config.js (NAV_ACCESS / ROLE_LABELS) and
// js/auth.js (ROLE_ALIASES) mirror this file.

const INTERNAL_ROLES = [
  'admin', 'super_admin', 'operations_manager', 'dispatcher',
  'field_lead', 'field_team', 'analyst', 'finance',
];

// Known synonyms ONLY. This table never fuzzy-matches, so an unknown or
// unauthorised role stays unknown rather than being promoted into a privileged
// one. Roles are set by admins and travel in a signed JWT, so these map data
// shape variants — not user input — onto the canonical key.
const ROLE_ALIASES = {
  administrator:       'admin',
  superadmin:          'super_admin',
  super_administrator: 'super_admin',
  ops_manager:         'operations_manager',
  opsmanager:          'operations_manager',
  operationsmanager:   'operations_manager',
  operations_mgr:      'operations_manager',
  ops_mgr:             'operations_manager',
  operation_manager:   'operations_manager',
  fieldlead:           'field_lead',
  fieldteam:           'field_team',
};

// lower-case, trim, collapse spaces/hyphens to underscores, then apply aliases.
// Non-string / empty input is returned unchanged (so a missing role stays
// missing and simply fails any requireRole match).
function normalizeRole(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ROLE_ALIASES[key] || key;
}

module.exports = { INTERNAL_ROLES, ROLE_ALIASES, normalizeRole };
