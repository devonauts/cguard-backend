import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import RoleRepository from '../../database/repositories/roleRepository';
import Permissions from '../../security/permissions';

export default async (req, res, next) => {
  try {
    if (!req.currentUser || !req.currentUser.id) {
      throw new Error403(req.language);
    }

    const user = req.currentUser;

    // Build a static role → [permissionIds] map from the compiled permissions definition.
    // This covers all built-in system roles (admin, securitySupervisor, hrManager, etc.)
    // that are never stored in the DB.
    const staticPermissionsMap: Record<string, string[]> = {};
    for (const perm of Object.values(Permissions.values) as any[]) {
      if (!perm || !Array.isArray(perm.allowedRoles)) continue;
      for (const roleSlug of perm.allowedRoles) {
        if (!staticPermissionsMap[roleSlug]) staticPermissionsMap[roleSlug] = [];
        staticPermissionsMap[roleSlug].push(perm.id);
      }
    }

    // Compute fresh tenant-scoped permissions from the DB role map so the frontend
    // always reflects the latest permissions — not just those at sign-in time.
    if (Array.isArray(user.tenants) && req.database) {
      for (const t of user.tenants) {
        try {
          const tenantId = t.tenantId || (t.tenant && t.tenant.id);
          if (!tenantId) continue;
          const roleMap = await RoleRepository.getPermissionsMapForTenant(tenantId, { database: req.database });
          const perms = new Set<string>();
          if (Array.isArray(t.roles)) {
            for (const r of t.roles) {
              // DB role map takes priority (custom/tenant-configured roles)
              const dbRolePerms = roleMap && roleMap[r] ? roleMap[r] : null;
              if (dbRolePerms && Array.isArray(dbRolePerms)) {
                dbRolePerms.forEach((p) => perms.add(p));
              } else {
                // Fall back to static permissions for built-in system roles
                // (securitySupervisor, admin, hrManager, dispatcher, etc.)
                const staticPerms = staticPermissionsMap[r] || [];
                staticPerms.forEach((p) => perms.add(p));
              }
            }
          }
          t.permissions = Array.from(perms);
        } catch (e) {
          // non-fatal — keep whatever was already on the tenant entry
        }

        // Expose trial / onboarding fields read from the loaded tenant relation.
        try {
          t.trialEndsAt = (t.tenant && t.tenant.trialEndsAt) ? t.tenant.trialEndsAt : null;
          t.billingStatus = (t.tenant && t.tenant.billingStatus) ? t.tenant.billingStatus : null;
          t.onboardingCompleted = (t.tenant && typeof t.tenant.onboardingCompleted !== 'undefined') ? Boolean(t.tenant.onboardingCompleted) : false;
        } catch (e) {
          // non-fatal
        }
      }
    }

    await ApiResponseHandler.success(req, res, user);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
