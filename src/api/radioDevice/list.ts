import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { serializeRadioDevice } from './serialize';

// GET /tenant/:tenantId/radio-devices
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioDeviceRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const where: any = { tenantId };
    if (req.query && req.query.postSiteId) where.postSiteId = req.query.postSiteId;
    if (req.query && req.query.stationId) where.stationId = req.query.stationId;
    if (req.query && typeof req.query.active !== 'undefined') {
      where.active = req.query.active === 'true' || req.query.active === true;
    }

    const rows = await db.radioDevice.findAll({ where, order: [['createdAt', 'DESC']] });
    const out = (rows || []).map(serializeRadioDevice);
    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
