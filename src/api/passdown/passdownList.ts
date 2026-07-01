import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { listPassdowns } from '../../services/shiftPassdownService';

// GET /tenant/:tenantId/passdown?stationId=&status=&limit=&offset=
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.taskRead);
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const q = req.query || {};
    const payload = await listPassdowns(db, tenantId, {
      stationId: q.stationId || (q.filter && q.filter.stationId),
      status: q.status || (q.filter && q.filter.status),
      limit: q.limit,
      offset: q.offset,
    });
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
