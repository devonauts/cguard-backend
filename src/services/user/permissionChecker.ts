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

const plans = Plans.values;

/**
 * Checks the Permission of the User on a Tenant.
 */
export default class PermissionChecker {
  currentTenant;
  language;
  currentUser;

  constructor({ currentTenant, language, currentUser }) {
    this.currentTenant = currentTenant;
    this.language = language;
    this.currentUser = currentUser;
  }

  /**
   * Validates if the user has a specific permission
   * and throws a Error403 if it doesn't.
   */
  validateHas(permission) {
    console.log('🔍 PermissionChecker.validateHas called with permission:', permission);
    console.log('  👤 currentUser:', this.currentUser?.id, this.currentUser?.email);
    console.log('  🏢 currentTenant:', this.currentTenant?.id);
    console.log('  🌐 language:', this.language);
    
    if (!this.has(permission)) {
      console.log('❌ Permission check failed - user does not have permission');
      throw new Error403(this.language);
    }
    console.log('✅ Permission check passed');
  }

  /**
   * Checks if the user has a specific permission.
   */
  has(permission) {
    assert(permission, 'permission is required');
    if (!this.isEmailVerified) {
      console.log('❌ Email not verified');
      return false;
    }
    console.log('✅ Email is verified');

    if (!this.hasPlanPermission(permission)) {
      console.log('❌ Plan does not have permission');
      return false;
    }
    console.log('✅ Plan has permission');

    // Shortcut: if the user has assigned clients or post sites for the
    // current tenant, allow some read permissions regardless of role.
    try {
      const tenantForUser = this.currentUser?.tenants
        ?.filter((t) => t.status === 'active')
        ?.find((t) => t.tenant.id === this.currentTenant.id);

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
            console.log('  ✅ Permission granted by assignedClients pivot (early)');
            return true;
          }
          if (permission.id === 'businessInfoRead' && hasAssignedPosts) {
            console.log('  ✅ Permission granted by assignedPostSites pivot (early)');
            return true;
          }
          if (permission.id === 'userRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for userRead (early)');
            return true;
          }
          if (permission.id === 'categoryRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for categoryRead (early)');
            return true;
          }
          if (permission.id === 'securityGuardRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for securityGuardRead (early)');
            return true;
          }
          if (permission.id === 'securityGuardEdit' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for securityGuardEdit (early)');
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
    console.log('🔍 Role permission result:', rolePermission);
    if (!rolePermission) {
      console.log('❌ Role does not have permission');
      return false;
    }
    console.log('✅ Role has permission');
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
    const result = this.currentUserRolesIds.some((role) =>
      permission.allowedRoles.some(
        (allowedRole) => allowedRole === role,
      ),
    );

    console.log('  🎯 Role permission result (static):', result);

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
              console.log(`  ✅ Permission granted by tenant role '${roleSlug}' via DB permissions map`);
              return true;
            }
          }
          console.log('  🔍 Dynamic role map present but did not contain permission for user roles');
        } else {
          console.log('  🔍 No dynamic role map cached for tenant');
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
          console.log(`  ✅ Permission granted by tenant.permissions attached to currentUser`);
          return true;
        }
        console.log('  🔍 tenant.permissions present but did not contain permission');
      }
    } catch (e) {
      console.warn('  ⚠️ Tenant attached permissions check failed:', e);
    }

    // Fallback: allow read access to clientAccount/businessInfo/category
    // when the user has assignments in the pivot tables for the current tenant.
    try {
      const tenant = this.currentUser.tenants
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant.id === this.currentTenant.id);

      if (tenant) {
        // Normalize assigned relations which may be arrays or JSON strings
        const assignedClients = tenant.assignedClients || [];
        const assignedPosts = tenant.assignedPostSites || [];

        console.log('  🔎 tenant.assignedClients type:', typeof assignedClients);
        console.log('  🔎 tenant.assignedClients value:', assignedClients);
        console.log('  🔎 tenant.assignedPostSites type:', typeof assignedPosts);
        console.log('  🔎 tenant.assignedPostSites value:', assignedPosts);

        const hasAssignedClients = Array.isArray(assignedClients)
          ? assignedClients.length > 0
          : (typeof assignedClients === 'string' && assignedClients.length > 2);

        const hasAssignedPosts = Array.isArray(assignedPosts)
          ? assignedPosts.length > 0
          : (typeof assignedPosts === 'string' && assignedPosts.length > 2);

        console.log(`  🔎 hasAssignedClients=${hasAssignedClients} hasAssignedPosts=${hasAssignedPosts}`);

        if (permission && permission.id) {
          if (permission.id === 'clientAccountRead' && hasAssignedClients) {
            console.log('  ✅ Permission granted by assignedClients pivot');
            return true;
          }

          if (permission.id === 'businessInfoRead' && hasAssignedPosts) {
            console.log('  ✅ Permission granted by assignedPostSites pivot');
            return true;
          }

          // Allow listing users if the user has any assigned clients/posts (optional policy)
          if (permission.id === 'userRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for userRead');
            return true;
          }

          if (permission.id === 'categoryRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for categoryRead');
            return true;
          }
          if (permission.id === 'securityGuardRead' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for securityGuardRead');
            return true;
          }
          if (permission.id === 'securityGuardEdit' && (hasAssignedClients || hasAssignedPosts)) {
            console.log('  ✅ Permission granted by pivot for securityGuardEdit');
            return true;
          }
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

    return this.currentUser.emailVerified;
  }

  /**
   * Returns the Current User Roles.
   */
  get currentUserRolesIds() {
    if (!this.currentUser || !this.currentUser.tenants) {
      console.log('❌ No currentUser or no tenants');
      return [];
    }
    

    const tenant = this.currentUser.tenants
      .filter(
        (tenantUser) => tenantUser.status === 'active',
      )
      .find((tenantUser) => {
        return (
          tenantUser.tenant.id === this.currentTenant.id
        );
      });

    if (!tenant) {
      console.log('❌ No active tenantUser found for tenant:', this.currentTenant.id);
      console.log('  Available tenants:', this.currentUser.tenants.map(t => ({ id: t.tenant.id, status: t.status })));
      return [];
    }

    console.log('✅ Found tenantUser for tenant:', this.currentTenant.id);

    // Handle both array and JSON string formats
    let roles = [];
    console.log('  🔎 raw tenant.roles value:', tenant.roles);
    try {
      console.log('  🔎 JSON.stringify tenant.roles:', JSON.stringify(tenant.roles));
    } catch (e) {
      console.log('  🔎 JSON stringify tenant.roles failed:', e);
    }
    try {
      console.log('  🔎 tenant object inspect:', safeStringify(tenant));
    } catch (e) {
      console.log('  🔎 tenant inspect failed:', e);
    }
    if (Array.isArray(tenant.roles)) {
      roles = tenant.roles;
    } else if (typeof tenant.roles === 'string') {
      try {
        roles = JSON.parse(tenant.roles);
      } catch (e) {
        console.log('  ❌ Failed to parse roles JSON:', e);
        roles = [];
      }
    }
    console.log('  🔎 parsed roles:', roles);
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
