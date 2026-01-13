import ApiResponseHandler from '../apiResponseHandler';
import TenantUrlService from '../../services/tenantUrlService';

export default async (req, res, next) => {
  try {
    const url = req.query.url;

    const result = await new TenantUrlService(req).isUrlAvailable(url);

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
