import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// GET /tenant/:tenantId/alarm/panels
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const where: any = { tenantId };
    if (req.query && req.query.postSiteId) where.postSiteId = req.query.postSiteId;
    if (req.query && req.query.stationId) where.stationId = req.query.stationId;
    if (req.query && req.query.customerId) where.customerId = req.query.customerId;
    if (req.query && req.query.status) where.status = req.query.status;
    if (req.query && req.query.panelType) where.panelType = req.query.panelType;
    if (req.query && typeof req.query.active !== 'undefined') {
      where.active = req.query.active === 'true' || req.query.active === true;
    }

    const rows = await db.alarmPanel.findAll({ where, order: [['createdAt', 'DESC']] });
    // SECURITY: never return the DC-09 AES key.
    const out = (rows || []).map((r: any) => {
      const p = typeof r.get === 'function' ? r.get({ plain: true }) : r;
      delete p.dc09Key;
      return p;
    });

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
