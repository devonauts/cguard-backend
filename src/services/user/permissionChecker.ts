import assert from 'assert';
// Avoid importing Node's `util` to prevent "Cannot find module 'util'"
// in environments where Node typings are unavailable. Use a small
// safeStringify helper instead.
function safeStringify(obj: any): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }, 2);
  } catch (e) {
    try {
      return String(obj);
    } catch (err) {
      return '[Unable to serialize object]';
    }
  }
}
import Error403 from '../../errors/Error403';
import Plans from '../../security/plans';
import Permissions from '../../security/permissions';
import RoleRepository from '../../database/repositories/roleRepository';
import EmailSender from '../emailSender';
import {
  computeTenantPermissions,
  ADMIN_FLOOR_PERMISSIONS,
  parsePermissionOverrides,
} from '../../security/staticRolePermissions';

const plans = Plans.values;

/**
 * Kill-switch for the new effective-set permission model (union of role sets →
 * +grant → −deny → admin floor → superadmin bypass). When OFF, the legacy
 * grant-only static-first path runs (behavior-preserving fallback). Flip via the
 * RBAC_EFFECTIVE_MODEL env var after a parity-verification window.
 */
function isEffectiveModelEnabled(): boolean {
  const v = String(process.env.RBAC_EFFECTIVE_MODEL || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}


/**
 * Checks the Permission of the User on a Tenant.
 */
export default class PermissionChecker {
  currentTenant;
  language;
  currentUser;
  private _effectivePerms: Set<string> | null = null;

  constructor({ currentTenant, language, currentUser }) {
    this.currentTenant = currentTenant;
    this.language = language;
    this.currentUser = currentUser;
  }

  /** True when the acting user is a global super administrator. */
  get isSuperadminUser(): boolean {
    return !!(this.currentUser && (this.currentUser as any).isSuperadmin);
  }

  /** The active tenantUser entry for the current tenant (or first active one). */
  get currentTenantEntry(): any {
    if (!this.currentUser || !Array.isArray(this.currentUser.tenants)) return null;
    const tenantId = this.currentTenant && this.currentTenant.id;
    const active = this.currentUser.tenants.filter((t) => t.status === 'active');
    if (tenantId) {
      return active.find((t) => t.tenant && t.tenant.id === tenantId) || null;
    }
    return active[0] || null;
  }

  /**
   * The user's effective permission id set for the current tenant under the new
   * model. Memoized per checker instance.
   *
   *   superadmin  → ALL permissions (bypass)
   *   otherwise   → union of each role's effective set (live DB map authoritative
   *                 when warm, else the signin/me-computed permissions, else
   *                 static defaults), then + per-user grant, − per-user deny,
   *                 then re-add the admin floor for admin holders.
   *
   * Precedence: superadmin > admin-floor > deny > grant > role-union.
   */
  get effectivePermissionIds(): Set<string> {
    if (this._effectivePerms) return this._effectivePerms;

    const set = new Set<string>();
    const roles: string[] = (this.currentUserRolesIds || []) as string[];

    // Superadmin bypass — global platform admin gets everything.
    if (this.isSuperadminUser || roles.includes('superadmin')) {
      (Permissions.asArray || []).forEach((p: any) => set.add(p.id));
      this._effectivePerms = set;
      return set;
    }

    const entry = this.currentTenantEntry;
    const tenantId = this.currentTenant && this.currentTenant.id;

    // Role-granted base.
    const liveMap = tenantId
      ? RoleRepository.getCachedPermissionsMapForTenant(tenantId)
      : null;
    const hasLive = !!liveMap && Object.keys(liveMap).length > 0;

    let base: string[];
    if (hasLive) {
      // Warm cache → authoritative DB role permissions (restriction works).
      // Customized roles are authoritative even when emptied.
      const customized = tenantId
        ? RoleRepository.getCachedCustomizedSlugsForTenant(tenantId)
        : undefined;
      base = computeTenantPermissions(liveMap, roles, customized);
    } else if (entry && Array.isArray(entry.permissions) && entry.permissions.length) {
      // Cold cache → the permissions computed at signin / last /auth/me
      // (already uses the same helper, so custom-role users aren't stranded).
      base = entry.permissions.slice();
    } else {
      // Last resort → static defaults union (built-in roles).
      base = computeTenantPermissions(null, roles);
    }
    base.forEach((p) => set.add(p));

    // Per-user overrides: add grants, then subtract denies (deny wins).
    const ov = parsePermissionOverrides(entry && entry.permissionOverrides);
    ov.grant.forEach((p) => set.add(p));
    ov.deny.forEach((p) => set.delete(p));

    // Admin floor: never removable for admin holders (lockout prevention).
    if (roles.includes('admin')) {
      ADMIN_FLOOR_PERMISSIONS.forEach((p) => set.add(p));
    }

    this._effectivePerms = set;
    return set;
  }

  /**
   * Validates if the user has a specific permission
   * and throws a Error403 if it doesn't.
   */
  validateHas(permission) {
    
    if (!this.has(permission)) {
      throw new Error403(this.language);
    }
  }

  /**
   * Checks if the user has a specific permission.
   */
  has(permission) {
    assert(permission, 'permission is required');
    if (!this.currentUser) {
      return false;
    }

    if (!this.isEmailVerified) {
      return false;
    }

    if (!this.hasPlanPermission(permission)) {
      return false;
    }

    // Shortcut: if the user has assigned clients or post sites for the
    // current tenant, allow some read permissions regardless of role.
    try {
      // Guard t.tenant / currentTenant nulls: a membership row can carry a null
      // tenant relation, and currentTenant may be unset on some paths — either
      // threw "Cannot read properties of null (reading 'id')" here.
      const currentTenantId = this.currentTenant?.id;
      const tenantForUser = currentTenantId
        ? this.currentUser?.tenants
            ?.filter((t) => t && t.status === 'active' && t.tenant)
            ?.find((t) => t.tenant.id === currentTenantId)
        : null;

      if (tenantForUser) {
        const assignedClients = tenantForUser.assignedClients || [];
        const assignedPosts = tenantForUser.assignedPostSites || [];

        const hasAssignedClients = Array.isArray(assignedClients)
          ? assignedClients.length > 0
          : (typeof assignedClients === 'string' && assignedClients.length > 2);

        const hasAssignedPosts = Array.isArray(assignedPosts)
          ? assignedPosts.length > 0
          : (typeof assignedPosts === 'string' && assignedPosts.length > 2);

        if (permission && permission.id) {
          if (permission.id === 'clientAccountRead' && hasAssignedClients) {
            return true;
          }
          if (permission.id === 'businessInfoRead' && hasAssignedPosts) {
            return true;
          }
          if (permission.id === 'userRead' && (hasAssignedClients || hasAssignedPosts)) {
            return true;
          }
          if (permission.id === 'categoryRead' && (hasAssignedClients || hasAssignedPosts)) {
            return true;
          }
          if (permission.id === 'securityGuardRead' && (hasAssignedClients || hasAssignedPosts)) {
            return true;
          }
          if (permission.id === 'securityGuardEdit' && (hasAssignedClients || hasAssignedPosts)) {
            return true;
          }
        }
      }
    } catch (e) {
      console.warn('PermissionChecker early pivot shortcut failed:', e);
    }

    // Dynamic tenant-scoped roles lookup is disabled in this runtime
    // to keep permission checks synchronous. DB-driven role
    // permissions will be integrated in a later change.
    // (Placeholder for future async lookup.)

    const rolePermission = this.hasRolePermission(permission);
    if (!rolePermission) {
      return false;
    }
    return true;
  }

  /**
   * Validates if the user has access to a storage
   * and throws a Error403 if it doesn't.
   */
  validateHasStorage(storageId) {
    if (!this.hasStorage(storageId)) {
      throw new Error403(this.language);
    }
  }

  /**
   * Validates if the user has access to a storage.
   */
  hasStorage(storageId: string) {
    assert(storageId, 'storageId is required');
    return this.allowedStorageIds().includes(storageId);
  }

  /**
   * Checks if the current user roles allows the permission.
   */
  hasRolePermission(permission) {
    // New effective-set model (behind kill-switch). Authoritative DB role sets,
    // per-user grant/deny, admin floor and superadmin bypass are all folded into
    // effectivePermissionIds. The pivot/assignment read grants remain an extra
    // additive source on top.
    if (isEffectiveModelEnabled()) {
      if (this.effectivePermissionIds.has(permission.id)) return true;
      return this._pivotFallback(permission);
    }

    const result = this.currentUserRolesIds.some((role) =>
      permission.allowedRoles.some(
        (allowedRole) => allowedRole === role,
      ),
    );


    if (result) return true;

    // Check dynamic tenant-scoped roles -> permissions map from cache (synchronous).
    try {
      const tenantId = this.currentTenant && this.currentTenant.id;
      if (tenantId) {
        const map = RoleRepository.getCachedPermissionsMapForTenant(tenantId);
        if (map && Object.keys(map).length) {
          // For each role assigned to the user, see if the role's permissions include this permission id
          for (const roleSlug of this.currentUserRolesIds) {
            const perms = map[roleSlug] || [];
            if (Array.isArray(perms) && perms.includes(permission.id)) {
              return true;
            }
          }
        } else {
        }
      }
    } catch (e) {
      console.warn('  ⚠️ Dynamic role permission check failed:', e);
    }

    // Fallback: if the signin flow attached `permissions` to the tenant entry
    // (computed from DB roles), honor it synchronously.
    try {
      const tenant = this.currentUser.tenants
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant.id === this.currentTenant.id);
      if (tenant && Array.isArray(tenant.permissions) && tenant.permissions.length) {
        if (tenant.permissions.includes(permission.id)) {
          return true;
        }
      }
    } catch (e) {
      console.warn('  ⚠️ Tenant attached permissions check failed:', e);
    }

    return this._pivotFallback(permission);
  }

  /**
   * Additive read grants from the assignment pivots (assigned clients / post
   * sites). Orthogonal to roles — kept identical across the legacy and the new
   * effective-set path.
   */
  _pivotFallback(permission): boolean {
    try {
      const tenant = this.currentUser.tenants
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant.id === this.currentTenant.id);

      if (tenant) {
        // Normalize assigned relations which may be arrays or JSON strings
        const assignedClients = tenant.assignedClients || [];
        const assignedPosts = tenant.assignedPostSites || [];

        const hasAssignedClients = Array.isArray(assignedClients)
          ? assignedClients.length > 0
          : (typeof assignedClients === 'string' && assignedClients.length > 2);

        const hasAssignedPosts = Array.isArray(assignedPosts)
          ? assignedPosts.length > 0
          : (typeof assignedPosts === 'string' && assignedPosts.length > 2);

        if (permission && permission.id) {
          if (permission.id === 'clientAccountRead' && hasAssignedClients) return true;
          if (permission.id === 'businessInfoRead' && hasAssignedPosts) return true;
          if (permission.id === 'userRead' && (hasAssignedClients || hasAssignedPosts)) return true;
          if (permission.id === 'categoryRead' && (hasAssignedClients || hasAssignedPosts)) return true;
          if (permission.id === 'securityGuardRead' && (hasAssignedClients || hasAssignedPosts)) return true;
          if (permission.id === 'securityGuardEdit' && (hasAssignedClients || hasAssignedPosts)) return true;
        }
      }
    } catch (e) {
      console.warn('PermissionChecker pivot fallback failed:', e);
    }

    return false;
  }

  /**
   * Checks if the current company plan allows the permission.
   */
  hasPlanPermission(permission) {
    assert(permission, 'permission is required');

    return permission.allowedPlans.includes(
      this.currentTenantPlan,
    );
  }

  get isEmailVerified() {
    // Only checks if the email is verified
    // if the email system is on
    if (!EmailSender.isConfigured) {
      return true;
    }

    // If there's no currentUser, consider email not verified so permission checks fail gracefully
    if (!this.currentUser) return false;

    return this.currentUser.emailVerified;
  }

  /**
   * Returns the Current User Roles.
   */
  get currentUserRolesIds() {
    if (!this.currentUser || !this.currentUser.tenants) {
      return [];
    }
    const tenantIdToFind = this.currentTenant && this.currentTenant.id;

    let tenant;
    if (tenantIdToFind) {
      tenant = this.currentUser.tenants
        .filter((tenantUser) => tenantUser.status === 'active')
        .find((tenantUser) => (tenantUser.tenant && tenantUser.tenant.id === tenantIdToFind));

      if (!tenant) {
        return [];
      }

    } else {
      // No currentTenant provided; fallback to first active tenantUser if present
      tenant = this.currentUser.tenants.find((tenantUser) => tenantUser.status === 'active');
      if (!tenant) {
        return [];
      }
    }

    // Handle both array and JSON string formats
    let roles = [];
    try {
    } catch (e) {
    }
    try {
    } catch (e) {
    }
    if (Array.isArray(tenant.roles)) {
      roles = tenant.roles;
    } else if (typeof tenant.roles === 'string') {
      try {
        roles = JSON.parse(tenant.roles);
      } catch (e) {
        roles = [];
      }
    }
        return roles;
  }

  /**
   * Return the current tenant plan,
   * check also if it's not expired.
   */
  get currentTenantPlan() {
    if (!this.currentTenant || !this.currentTenant.plan) {
      return plans.free;
    }

    return this.currentTenant.plan;
  }

  /**
   * Returns the allowed storage ids for the user.
   */
  allowedStorageIds() {
    let allowedStorageIds: Array<string> = [];

    Permissions.asArray.forEach((permission) => {
      if (this.has(permission)) {
        allowedStorageIds = allowedStorageIds.concat(
          (permission.allowedStorage || []).map(
            (storage) => storage.id,
          ),
        );
      }
    });

    return [...new Set(allowedStorageIds)];
  }
}
