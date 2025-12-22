import assert from 'assert';
import Error403 from '../../errors/Error403';
import Plans from '../../security/plans';
import Permissions from '../../security/permissions';
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

    const rolePermission = this.hasRolePermission(permission);
    console.log('🔍 Role permission result:', rolePermission);
    return rolePermission;
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
    
    console.log('  🎯 Role permission result:', result);
    return result;
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
      return [];
    }

    // Handle both array and JSON string formats
    let roles = [];
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
