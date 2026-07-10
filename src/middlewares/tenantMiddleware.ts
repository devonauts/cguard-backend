import TenantService from '../services/tenantService';
import { isUserInTenant } from '../database/utils/userTenantUtils';
import { isSuperadminUser } from './superadminMiddleware';
import Error403 from '../errors/Error403';
import { enforcePaywall } from './paywall';

export async function tenantMiddleware(
  req,
  res,
  next,
  value,
  name,
) {
  try {
    // Reuse the tenant AuthService.findByToken already loaded and attached as
    // req.currentTenant (tenant + settings + logo) when the token carried a
    // tenantId — re-fetching the identical row here doubled the tenant query on
    // every /tenant/:tenantId request. Only reused when the URL param matches
    // the already-loaded tenant; any other :tenantId is still loaded fresh so
    // the membership check below validates exactly what the URL asked for.
    const preloaded = req.currentTenant;
    const tenant =
      preloaded && preloaded.id === value
        ? preloaded
        : await new TenantService(req).findById(value);

    // ── Tenant isolation ──────────────────────────────────────────────────
    // The middleware loads ANY tenant by id, so without this an authenticated
    // user could coerce :tenantId to a tenant they don't belong to on any handler
    // that doesn't run a PermissionChecker (the permission check is what implicitly
    // gated cross-tenant access elsewhere). Enforce membership centrally here.
    // Superadmins are exempt (they manage across tenants). Only enforced for
    // authenticated users whose memberships are loaded — PermissionChecker already
    // relies on currentUser.tenants being present — so anonymous/lean requests keep
    // their existing handler-level behaviour and nothing legitimately scoped breaks.
    if (
      req.currentUser &&
      Array.isArray(req.currentUser.tenants) &&
      !isSuperadminUser(req.currentUser) &&
      !isUserInTenant(req.currentUser, tenant)
    ) {
      throw new Error403(req.language);
    }

    req.currentTenant = tenant;
    if (enforcePaywall(req, res)) return;
    next();
  } catch (error) {
    next(error);
  }
}
