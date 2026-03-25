import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.stationDestroy,
    );

    // Accept either query param `ids` (array or comma-separated string)
    // or single id in path param `:id` for compatibility with frontend.
    let ids: any = req.query.ids;
    if (!ids && req.params && req.params.id) {
      ids = req.params.id;
    }

    // Normalize ids to an array
    if (typeof ids === 'string') {
      // comma separated
      ids = ids.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }

    await new StationService(req).destroyAll(
      ids,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
