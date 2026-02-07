import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    const payload = req.body && req.body.data ? req.body.data : req.body;
    const record = await service.update(req.params.id, payload);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
