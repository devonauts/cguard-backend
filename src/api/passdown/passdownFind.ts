import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { findPassdownById } from '../../services/shiftPassdownService';

// GET /tenant/:tenantId/passdown/:id  → full detail (photos + instruction tasks)
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.taskRead);
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const passdown = await findPassdownById(db, tenantId, req.params.id);
    if (!passdown) throw new Error404();
    await ApiResponseHandler.success(req, res, { passdown });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
