import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// GET /tenant/:tenantId/alarm/action-plans
// Optional filters: ?alarmPanelId= , ?appliesToCategory= , ?active=
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const where: any = { tenantId };
    if (req.query && req.query.alarmPanelId) where.alarmPanelId = req.query.alarmPanelId;
    if (req.query && req.query.appliesToCategory) where.appliesToCategory = req.query.appliesToCategory;
    if (req.query && typeof req.query.active !== 'undefined') {
      where.active = req.query.active === 'true' || req.query.active === true;
    }

    const rows = await db.actionPlan.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });

    const out = (rows || []).map((r: any) =>
      typeof r.get === 'function' ? r.get({ plain: true }) : r,
    );

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
