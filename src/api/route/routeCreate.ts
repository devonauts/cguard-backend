import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import RouteService from '../../services/routeService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.routeCreate);

    // Debug: log currentTenant to ensure tenant middleware ran
    try {
      // avoid logging sensitive data, just tenant id
      console.log('routeCreate - req.currentTenant:', req.currentTenant ? req.currentTenant.id : null);
    } catch (e) {
      console.warn('routeCreate - unable to log currentTenant', String((e as any)?.message || e));
    }

    const payload = await new RouteService(req).create(req.body.data);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
