import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { serializeRelaySite } from './_relaySite';

// GET /tenant/:tenantId/video/relay-sites
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const rows = await db.videoRelaySite.findAll({ where: { tenantId }, order: [['createdAt', 'DESC']] });
    const out = (rows || []).map(serializeRelaySite);
    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
