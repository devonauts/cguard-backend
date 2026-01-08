import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaxService from '../../services/taxService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.taxDestroy,
    );

    await new TaxService(req).destroyAll(
      req.body.ids || [req.params.id],
    );

    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
