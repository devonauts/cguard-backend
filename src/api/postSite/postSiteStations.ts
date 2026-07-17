import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);

    // Forward query to StationService with the postSite filter under `filter`
    // (the repository reads filter.postSite; a top-level postSiteId was silently
    // ignored → the endpoint returned EVERY tenant station, leaking other
    // clients' stations + guards into this site's roster).
    const params = {
      ...(req.query || {}),
      filter: { ...((req.query && (req.query as any).filter) || {}), postSite: req.params.id },
    };
    const payload = await new StationService(req).findAndCountAll(params);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
