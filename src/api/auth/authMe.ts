import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import RoleRepository from '../../database/repositories/roleRepository';
import {
  computeTenantPermissions,
  applyUserOverridesAndFloor,
} from '../../security/staticRolePermissions';

export default async (req, res, next) => {
  try {
    if (!req.currentUser || !req.currentUser.id) {
      throw new Error403(req.language);
    }

    const user = req.currentUser;

    // Compute fresh tenant-scoped permissions from the DB role map so the frontend
    // always reflects the latest permissions — not just those at sign-in time.
    // The DB role map takes priority for tenant-configured roles; built-in system
    // roles (admin, securitySupervisor, hrManager, dispatcher, …) fall back to the
    // static defaults derived from permissions.ts. See staticRolePermissions.ts —
    // this is the SAME helper signin uses so /auth/me and signin never diverge.
    if (Array.isArray(user.tenants) && req.database) {
      for (const t of user.tenants) {
        try {
          const tenantId = t.tenantId || (t.tenant && t.tenant.id);
          if (!tenantId) continue;
          const roleMap = await RoleRepository.getPermissionsMapForTenant(tenantId, { database: req.database });
          const customized = RoleRepository.getCachedCustomizedSlugsForTenant(tenantId);
          const roleSlugs = Array.isArray(t.roles) ? t.roles : [];
          const base = computeTenantPermissions(roleMap, roleSlugs, customized);
          // Apply per-user grant/deny + admin floor so the frontend's flat
          // permissions[] matches what the checker enforces. Expose the raw
          // overrides too so the admin-user edit screen can render them.
          t.permissionOverrides = t.permissionOverrides || { grant: [], deny: [] };
          t.permissions = applyUserOverridesAndFloor(base, t.permissionOverrides, roleSlugs);
        } catch (e) {
          // non-fatal — keep whatever was already on the tenant entry
        }

        // Expose trial / onboarding fields read from the loaded tenant relation.
        try {
          t.trialEndsAt = (t.tenant && t.tenant.trialEndsAt) ? t.tenant.trialEndsAt : null;
          t.billingStatus = (t.tenant && t.tenant.billingStatus) ? t.tenant.billingStatus : null;
          t.onboardingCompleted = (t.tenant && typeof t.tenant.onboardingCompleted !== 'undefined') ? Boolean(t.tenant.onboardingCompleted) : false;
          // Suspension state so the CRM can render the hard-lockout screen.
          t.suspendedAt = (t.tenant && t.tenant.suspendedAt) ? t.tenant.suspendedAt : null;
          t.suspensionReason = (t.tenant && t.tenant.suspensionReason) ? t.tenant.suspensionReason : null;

          // Plan entitlements + seat cap so the CRM can feature-gate by tier.
          // Fail-open: on any error the tenant keeps full access.
          try {
            if (t.tenant) {
              const svc = require('../../services/planCatalogService');
              const resolved = await svc.resolveForTenant(req.database, t.tenant);
              t.planKey = resolved.planKey;
              t.planFeatures = resolved.features;
              t.seatCap = resolved.seatCap;
            }
          } catch (e) {
            // non-fatal — omit entitlements, CRM treats absence as "all allowed"
          }
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
