import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import permissions from '../../security/permissions';
import DashboardService from '../../services/dashboardService';

export default async (req, res, next) => {
  try {
    new PermissionChecker({
      currentTenant: req.currentTenant,
      language: req.language,
      currentUser: req.currentUser
    }).validateHas(
      permissions.values.businessInfoRead,
    );

    const payload = await new DashboardService(
      req,
    ).getAllDashboardStats();

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    console.error('❌ Dashboard API error:', error);
    await ApiResponseHandler.error(req, res, error);
  }
};