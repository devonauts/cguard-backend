/**
 * GET /tenant/:tenantId/alarm/events?caseId=&panelId=&limit=
 *
 * List alarm events for the tenant, newest first. Optionally filtered by case
 * or panel. Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const { caseId, panelId } = req.query || {};
    const rawLimit = parseInt(String((req.query || {}).limit), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    const where: any = { tenantId };
    if (caseId) where.alarmCaseId = caseId;
    if (panelId) where.alarmPanelId = panelId;

    const events = await db.alarmEvent.findAll({
      where,
      include: [{ model: db.alarmPanel, as: 'panel', required: false }],
      order: [
        ['at', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit,
    });

    await ApiResponseHandler.success(req, res, events);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
