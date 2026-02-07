import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    const results = await service.findAllAutocomplete(req.query.query, req.query.limit);
    await ApiResponseHandler.success(req, res, results);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
