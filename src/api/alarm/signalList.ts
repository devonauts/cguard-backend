/**
 * GET /tenant/:tenantId/alarm/signals?panelId=&limit=
 *
 * List raw (immutable) alarm signals for the tenant, newest first. Optionally
 * filtered by panel. Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const { panelId } = req.query || {};
    const rawLimit = parseInt(String((req.query || {}).limit), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

    const where: any = { tenantId };
    if (panelId) where.alarmPanelId = panelId;

    const signals = await db.alarmSignal.findAll({
      where,
      order: [
        ['receivedAt', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit,
    });

    await ApiResponseHandler.success(req, res, signals);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
