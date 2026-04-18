import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import VehicleService from '../../services/vehicleService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.vehicleDestroy,
    );

    let ids: any = req.query.ids;
    if (!ids && req.params && req.params.id) {
      ids = req.params.id;
    }

    if (typeof ids === 'string') {
      ids = ids.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }

    await new VehicleService(req).destroyAll(
      ids,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
