import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import EstimateService from '../../services/estimateService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateDestroy,
    );

    await new EstimateService(req).destroyAll([
      req.params.id,
    ]);

    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
