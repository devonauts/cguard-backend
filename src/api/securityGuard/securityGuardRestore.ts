import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRestore,
    );

    // normalize ids from query or body
    let ids = req.query.ids ?? (req.body && req.body.ids);
    if (typeof ids === 'string') {
      ids = ids.includes(',') ? ids.split(',').map((s) => s.trim()).filter(Boolean) : [ids];
    } else if (!Array.isArray(ids)) {
      ids = ids ? [ids] : [];
    }

    await new SecurityGuardService(req).restoreAll(
      ids,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
