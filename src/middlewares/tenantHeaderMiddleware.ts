import TenantService from '../services/tenantService';
import { isUserInTenant } from '../database/utils/userTenantUtils';
import Error403 from '../errors/Error403';

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

    // Find tenant and set as currentTenant
    const tenant = await new TenantService(req).findById(tenantId);

    // If there is a currentUser, ensure membership
    if (!isUserInTenant(req.currentUser, tenant)) {
      throw new Error403(req.language);
    }

    req.currentTenant = tenant;
    return next();
  } catch (err) {
    return next(err);
  }
}
