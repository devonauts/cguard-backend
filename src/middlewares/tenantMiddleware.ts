import TenantService from '../services/tenantService';
import { enforcePaywall } from './paywall';

export async function tenantMiddleware(
  req,
  res,
  next,
  value,
  name,
) {
  try {
    const tenant = await new TenantService(req).findById(
      value,
    );
    req.currentTenant = tenant;
    if (enforcePaywall(req, res)) return;
    next();
  } catch (error) {
    next(error);
  }
}
