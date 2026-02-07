import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    const payload = req.body && req.body.data ? req.body.data : req.body;
    const service = new KpiService(req);
    const record = await service.create(payload);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
