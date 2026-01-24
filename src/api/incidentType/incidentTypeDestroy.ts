import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentTypeService from '../../services/incidentTypeService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.incidentTypeDestroy,
    );

    // Support ids passed as query string (comma separated) or in request body
    let ids: any = req.query.ids || (req.body && req.body.ids);
    if (!ids) {
      ids = [];
    }
    if (typeof ids === 'string') {
      ids = ids.split(',').filter((s) => s);
    }
    if (!Array.isArray(ids)) {
      ids = [ids];
    }

    await new IncidentTypeService(req).destroyAll(
      ids,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
