import TenantService from '../services/tenantService';
import { isUserInTenant } from '../database/utils/userTenantUtils';
import Error403 from '../errors/Error403';
import { enforcePaywall } from './paywall';

export async function tenantFromHeaderMiddleware(req, res, next) {
  try {
    const headerTenantId = req.headers['x-tenant-id'] || req.headers['X-Tenant-Id'];
    if (!headerTenantId) {
      return next();
    }

    const tenantId = Array.isArray(headerTenantId)
      ? headerTenantId[0]
      : String(headerTenantId);

    if (!tenantId) return next();

    // Find tenant and set as currentTenant. Reuse the tenant AuthService.findByToken
    // already loaded onto req.currentTenant (same tenant + settings + logo include)
    // when the header matches it, instead of re-querying the identical row.
    const preloaded = req.currentTenant;
    const tenant =
      preloaded && preloaded.id === tenantId
        ? preloaded
        : await new TenantService(req).findById(tenantId);

    // If there is a currentUser, ensure membership
    if (!isUserInTenant(req.currentUser, tenant)) {
      throw new Error403(req.language);
    }

    req.currentTenant = tenant;
    if (enforcePaywall(req, res)) return;
    return next();
  } catch (err) {
    return next(err);
  }
}
