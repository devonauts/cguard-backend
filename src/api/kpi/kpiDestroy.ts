import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';
import Permissions from '../../security/permissions';
import { enforceGate } from '../../security/gateEnforcement';

export default async (req, res, next) => {
  try {
    enforceGate(req, Permissions.values.settingsEdit);
    const service = new KpiService(req);
    await service.destroyAll([req.params.id]);
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
