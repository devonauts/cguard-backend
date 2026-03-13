import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardLicenseService from '../../services/guardLicenseService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardEdit,
    );

    let ids = req.query.ids ?? (req.body && req.body.ids);

    if (typeof ids === 'string') {
      // support comma-separated lists like "1,2,3"
      ids = ids.includes(',')
        ? ids.split(',').map((s) => s.trim()).filter(Boolean)
        : [ids];
    }

    await new GuardLicenseService(req).destroyAll(ids || []);

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
