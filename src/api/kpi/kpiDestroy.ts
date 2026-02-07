import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    await service.destroyAll([req.params.id]);
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
