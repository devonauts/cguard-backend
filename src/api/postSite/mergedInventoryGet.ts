import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryService from '../../services/inventoryService';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryRead,
    );

    const postSiteId = req.params.id;
    if (!postSiteId) {
      return ApiResponseHandler.success(req, res, []);
    }

    // Load postSite-level inventories
    const inventoryService = new InventoryService(req);
    const postSiteInv = await inventoryService.findAndCountAll({ filter: { belongsTo: postSiteId }, limit: 0 });
    const postRows = (postSiteInv && postSiteInv.rows) ? postSiteInv.rows : [];

    // Load stations for this postSite and then any station-scoped inventories
    const stationService = new StationService(req);
    const stationsRes = await stationService.findAndCountAll({ filter: { postSite: postSiteId }, limit: 0 });
    const stations = (stationsRes && stationsRes.rows) ? stationsRes.rows : [];

    const stationInventories: any[] = [];
    for (const st of stations) {
      try {
        const invRes = await inventoryService.findAndCountAll({ filter: { belongsTo: st.id }, limit: 1 });
        const rows = (invRes && invRes.rows) ? invRes.rows : [];
        if (rows.length) {
          // annotate inventory with origin info expected by frontend
          rows.forEach((r: any) => stationInventories.push({ ...(r as any), originType: 'station', originId: st.id, originName: st.stationName || st.name || (st.postSite && st.postSite.businessName) || null } as any));
        }
      } catch (e) {
        // ignore per-station failures
        console.warn('[mergedInventoryGet] failed loading inventory for station', st.id, (e as any).message || e);
      }
    }

    // Annotate postSite inventories
    const annotatedPost = postRows.map((r) => ({ ...r, originType: 'postSite', originId: postSiteId }));

    const combined = [...annotatedPost, ...stationInventories];

    await ApiResponseHandler.success(req, res, { inventories: combined });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
