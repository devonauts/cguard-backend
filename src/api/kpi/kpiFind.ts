import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import KpiService from '../../services/kpiService';

export default async (req, res, next) => {
  try {
    // KPI is internal staff analytics — keep customers out (no kpiRead perm exists;
    // settingsRead = ALL_STAFF_ROLES is the staff-wide read gate).
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const service = new KpiService(req);
    const record = await service.findById(req.params.id);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
