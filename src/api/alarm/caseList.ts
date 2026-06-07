/**
 * GET /tenant/:tenantId/alarm/cases?status=
 *
 * List alarm cases for the tenant. Optionally filter by status. Ordered by
 * priority ascending (1 = critical first) then newest created first.
 * Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const { status } = req.query || {};

    const where: any = { tenantId };
    if (status) where.status = status;

    const cases = await db.alarmCase.findAll({
      where,
      include: [{ model: db.alarmPanel, as: 'panel', required: false }],
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'DESC'],
      ],
    });

    await ApiResponseHandler.success(req, res, cases);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
