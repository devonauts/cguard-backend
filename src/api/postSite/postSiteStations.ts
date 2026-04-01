import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);

    // Forward query to StationService but ensure postSiteId filter is applied
    const params = Object.assign({}, req.query || {}, { postSiteId: req.params.id });
    const payload = await new StationService(req).findAndCountAll(params);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
