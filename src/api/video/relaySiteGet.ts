import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { serializeRelaySite } from './_relaySite';

// GET /tenant/:tenantId/video/relay-site/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const record = await db.videoRelaySite.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) { const err: any = new Error('Not found'); err.code = 404; throw err; }
    await ApiResponseHandler.success(req, res, serializeRelaySite(record));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
