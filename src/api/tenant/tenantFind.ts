import ApiResponseHandler from '../apiResponseHandler';
import TenantService from '../../services/tenantService';
import Error403 from '../../errors/Error403';
import { isUserInTenant } from '../../database/utils/userTenantUtils';

export default async (req, res, next) => {
  try {
    let payload;

    const tenantId = req.params.tenantId || req.params.id;

    if (tenantId) {
      // A user may only read a tenant they belong to. tenantMiddleware sets
      // req.currentTenant from the URL but does NOT verify membership, so without
      // this guard any authenticated user could read any tenant's record
      // (name, taxNumber, plan, Stripe customer id, settings).
      if (!isUserInTenant(req.currentUser, { id: tenantId })) {
        throw new Error403(req.language);
      }
      payload = await new TenantService(req).findById(
        tenantId,
      );
    } else {
      payload = await new TenantService(req).findByUrl(
        req.query.url,
      );
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
