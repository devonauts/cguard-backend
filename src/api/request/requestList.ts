import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentService from '../../services/incidentService';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.requestRead,
    );

    // Normalize query parameters: support both top-level params (status, query)
    // and bracketed filter params like `filter[clientId]=...` which clients send.
    const raw = req.query || {};
    const args: any = { ...raw };
    args.filter = args.filter || {};

    for (const key of Object.keys(raw)) {
      const m = key.match(/^filter\[(.+)\]$/);
      if (m) {
        args.filter[m[1]] = raw[key];
        delete args[key];
      }
    }

    // If caller provided a siteId filter, map it to station IDs for incidents
    if (args.filter && args.filter.siteId) {
      try {
        const stationService = new StationService(req);
        const stationsResp = await stationService.findAndCountAll({ filter: { postSite: args.filter.siteId }, limit: 0, offset: 0 });
        const stationRows = Array.isArray(stationsResp.rows) ? stationsResp.rows : [];
        const stationIds = stationRows.map((s) => s.id).filter(Boolean);
        // set filter for incidents repository
        args.filter.stationIncidents = stationIds.length ? stationIds : null;
        // remove siteId to avoid confusion downstream
        delete args.filter.siteId;
      } catch (err) {
        // If station lookup fails, log and continue without mapping
        console.warn('Failed to map siteId to stations', err);
      }
    }

    // Use IncidentService to list incidents (possibly filtered by stationIncidents)
    const payload = await new IncidentService(
      req,
    ).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
