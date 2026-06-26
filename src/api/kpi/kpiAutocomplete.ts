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
    const results = await service.findAllAutocomplete(req.query.query, req.query.limit);
    await ApiResponseHandler.success(req, res, results);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
