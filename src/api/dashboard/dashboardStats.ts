import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import permissions from '../../security/permissions';
import DashboardService from '../../services/dashboardService';

export default async (req, res, next) => {
  try {
    await new PermissionChecker(req).validateHas(
      permissions.values.businessInfoRead,
    );

    const payload = await new DashboardService(
      req,
    ).getAllDashboardStats();

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};