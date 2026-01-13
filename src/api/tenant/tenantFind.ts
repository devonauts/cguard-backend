import ApiResponseHandler from '../apiResponseHandler';
import TenantService from '../../services/tenantService';

export default async (req, res, next) => {
  try {
    let payload;

    const tenantId = req.params.tenantId || req.params.id;

    if (tenantId) {
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
