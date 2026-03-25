import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftService from '../../services/shiftService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.shiftDestroy,
    );

    // Accept either query param `ids` or single id in path param `:id`.
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

    await new ShiftService(req).destroyAll(
      ids,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
