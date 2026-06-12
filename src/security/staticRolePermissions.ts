import Permissions from './permissions';

/**
 * Single source of truth for deriving the permissions a role grants by DEFAULT
 * (i.e. the compiled `permissions.ts` `allowedRoles` lists, inverted into a
 * role -> [permissionId] map). Built-in/system roles (admin, dispatcher,
 * securityGuard, …) are never persisted with real permissions historically, so
 * this static map is what `authMe`, signin and the permission checker fall back
 * to when a tenant has NOT customized a role.
 *
 * This used to live inline in authMe.ts; it is centralized here so signin, the
 * /auth/me refresh and permissionChecker all compute identical results.
 */

let _cachedMap: Record<string, string[]> | null = null;

export function buildStaticRolePermissionsMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const perm of Object.values(Permissions.values) as any[]) {
    if (!perm || !Array.isArray(perm.allowedRoles)) continue;
    for (const roleSlug of perm.allowedRoles) {
      if (!map[roleSlug]) map[roleSlug] = [];
      if (!map[roleSlug].includes(perm.id)) map[roleSlug].push(perm.id);
    }
  }
  return map;
}

function staticMap(): Record<string, string[]> {
  if (!_cachedMap) _cachedMap = buildStaticRolePermissionsMap();
  return _cachedMap;
}

/** The default permission ids a built-in role grants, derived from permissions.ts. */
export function getStaticDefaultsForRole(slug: string): string[] {
  const m = staticMap();
  return Array.isArray(m[slug]) ? [...m[slug]] : [];
}

/**
 * Admin "floor": permissions that must NEVER be removable from the admin role
 * or from an admin user, otherwise a tenant could lock itself out of the role &
 * user management surface with no way back in. Enforced on BOTH the write side
 * (role/override saves reject removing these) and the read side (the checker
 * re-adds them for admin holders).
 */
export const ADMIN_FLOOR_PERMISSIONS: string[] = [
  'settingsEdit', // gates role create/update/destroy/reset
  'settingsRead',
  'userRead',
  'userCreate',
  'userEdit',
  'userDestroy',
  'tenantEdit',
];

/** Role slugs that receive the admin floor (i.e. the "admin" tier). */
export const FLOOR_ROLE_SLUGS: string[] = ['admin'];

/** Normalize a permissionOverrides value (may be a JSON string or object). */
export function parsePermissionOverrides(raw: any): { grant: string[]; deny: string[] } {
  let o = raw;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch (e) { o = null; }
  }
  const grant = o && Array.isArray(o.grant) ? o.grant.filter((x) => typeof x === 'string') : [];
  const deny = o && Array.isArray(o.deny) ? o.deny.filter((x) => typeof x === 'string') : [];
  return { grant, deny };
}

/**
 * Apply per-user overrides (+grant, −deny) and the admin floor to a base
 * permission list. Used to keep the signin / /auth/me flat `permissions[]` in
 * sync with what the permission checker enforces. deny wins over grant; the
 * admin floor is re-added last for admin holders so it can never be denied.
 */
export function applyUserOverridesAndFloor(
  basePerms: string[],
  rawOverrides: any,
  roles: string[] | null | undefined,
): string[] {
  const set = new Set(Array.isArray(basePerms) ? basePerms : []);
  const ov = parsePermissionOverrides(rawOverrides);
  ov.grant.forEach((p) => set.add(p));
  ov.deny.forEach((p) => set.delete(p));
  if (Array.isArray(roles) && roles.includes('admin')) {
    ADMIN_FLOOR_PERMISSIONS.forEach((p) => set.add(p));
  }
  return Array.from(set);
}

/**
 * Compute the effective tenant-scoped permission id list for a set of role
 * slugs, given the per-tenant DB role map (RoleRepository.getPermissionsMapForTenant).
 *
 * Per role:
 *  - If the tenant has CUSTOMIZED the role (slug in `customizedSlugs`), the DB
 *    array is authoritative — even when empty (the tenant deliberately removed
 *    everything).
 *  - Else if the DB row has a non-empty permission set, use it.
 *  - Else fall back to the static defaults for that role.
 *
 * The result is the UNION across all of the user's roles.
 *
 * NOTE: callers that don't yet track customization (signin / authMe in PR-1)
 * pass no `customizedSlugs`, giving the historical "DB-if-non-empty-else-static"
 * behavior — a pure refactor. The checker (PR-2+) passes the customized set so
 * an emptied custom role is honored.
 */
export function computeTenantPermissions(
  roleMap: Record<string, string[]> | null | undefined,
  roles: string[] | null | undefined,
  customizedSlugs?: Set<string>,
): string[] {
  const perms = new Set<string>();
  const list = Array.isArray(roles) ? roles : [];
  for (const r of list) {
    const present = !!roleMap && Object.prototype.hasOwnProperty.call(roleMap, r);
    const dbPerms = present && Array.isArray(roleMap![r]) ? roleMap![r] : null;
    const isCustomized = !!customizedSlugs && customizedSlugs.has(r);

    let source: string[];
    if (dbPerms && (dbPerms.length > 0 || isCustomized)) {
      source = dbPerms;
    } else {
      source = getStaticDefaultsForRole(r);
    }
    source.forEach((p) => perms.add(p));
  }
  return Array.from(perms);
}
