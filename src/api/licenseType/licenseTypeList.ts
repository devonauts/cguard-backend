import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import LicenseTypeService from '../../services/licenseTypeService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.licenseTypeRead,
    );

    const filter = req.query || {};
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = parseInt(req.query.offset, 10) || 0;
    const orderBy = req.query.orderBy || 'createdAt_DESC';

    const payload = await new LicenseTypeService(req).findAndCountAll({ filter, limit, offset, orderBy });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
