// Single source of truth for admin capabilities on the front end. This mirrors
// the RLS helper current_user_has_permission() so the panel shows exactly what
// the backend will allow. Pure module: no DOM, no network, fully unit-testable.

export const PERMISSIONS = [
  { key: 'manage_reports', label: 'Moderate reports' },
  { key: 'delete_reports', label: 'Delete reports' },
  { key: 'ban_users',      label: 'Ban users' },
  { key: 'manage_phrases', label: 'Manage banned phrases' },
  { key: 'manage_admins',  label: 'Manage admins' },
  { key: 'view_analytics', label: 'View analytics' },
  { key: 'manage_games',   label: 'Manage games (hide / remap)' },
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map(p => p.key);

export const PERMISSION_LABELS = Object.fromEntries(PERMISSIONS.map(p => [p.key, p.label]));

// Role presets fill a permission group; a super_admin always has everything.
export const ROLE_PRESETS = {
  moderator:   ['manage_reports', 'delete_reports', 'ban_users', 'view_analytics', 'manage_games'],
  super_admin: ALL_PERMISSION_KEYS.slice(),
};

// Which permission(s) gate each tab. A tab absent from this map is visible to
// any admin (the Users tab). The tab shows if the admin has ANY listed perm.
export const TAB_PERMISSIONS = {
  flagged:   ['manage_reports', 'delete_reports'],
  banned:    ['ban_users'],
  admins:    ['manage_admins'],
  phrases:   ['manage_phrases'],
  analytics:      ['view_analytics'],
  boxart:         ['view_analytics'],
  'api-explorer': ['view_analytics'],
  'depot-tracking': ['view_analytics'],
  games:          ['manage_games'],
};

// Effective permissions for an admin. super_admin short-circuits to all.
export function effectivePermissions(role, permissions = []) {
  if (role === 'super_admin') return ALL_PERMISSION_KEYS.slice();
  return Array.isArray(permissions) ? permissions.slice() : [];
}

export function hasPermission(role, permissions, key) {
  return effectivePermissions(role, permissions).includes(key);
}

export function canSeeTab(role, permissions, tab) {
  const required = TAB_PERMISSIONS[tab];
  if (!required) return true; // ungated tab (e.g. Users)
  const eff = effectivePermissions(role, permissions);
  return required.some(k => eff.includes(k));
}

export function visibleTabs(role, permissions, allTabs) {
  return allTabs.filter(t => canSeeTab(role, permissions, t));
}

// Permission set for a role preset (empty for custom/unknown).
export function presetFor(role) {
  return (ROLE_PRESETS[role] || []).slice();
}

// Add a permission to a set (deduped, ignores unknown keys). Returns a new array.
export function addPermission(permissions, key) {
  const perms = Array.isArray(permissions) ? permissions : [];
  if (!ALL_PERMISSION_KEYS.includes(key) || perms.includes(key)) return perms.slice();
  return [...perms, key];
}

// Remove a permission from a set. Returns a new array.
export function removePermission(permissions, key) {
  return (Array.isArray(permissions) ? permissions : []).filter(k => k !== key);
}

// Permissions not yet in the set, in canonical order (what an "add" control offers).
export function permissionsToAdd(permissions) {
  const perms = Array.isArray(permissions) ? permissions : [];
  return ALL_PERMISSION_KEYS.filter(k => !perms.includes(k));
}

// Display label for an admin's role: a preset name when the effective set
// matches a preset exactly (order-insensitive), otherwise 'custom'.
export function resolveRoleLabel(role, permissions) {
  if (role === 'super_admin') return 'super_admin';
  const eff = (Array.isArray(permissions) ? permissions : []).slice().sort();
  for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
    if (name === 'super_admin') continue;
    const p = preset.slice().sort();
    if (p.length === eff.length && p.every((k, i) => k === eff[i])) return name;
  }
  return 'custom';
}
