import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    const payload = await service.findAndCountAll({ filter: req.query, limit: req.query.limit, offset: req.query.offset, orderBy: req.query.orderBy });
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
