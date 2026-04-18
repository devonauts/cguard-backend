import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import RouteService from '../../services/routeService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.routeDestroy);

    await new RouteService(req).destroyAll(req.body.ids || req.query.ids);

    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
