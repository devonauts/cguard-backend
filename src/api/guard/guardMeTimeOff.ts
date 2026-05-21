/**
 * GET /api/tenant/:tenantId/guard/me/time-off
 * 
 * Returns the guard's own time-off requests.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    if (!securityGuard) {
      return ApiResponseHandler.success(req, res, { rows: [] });
    }

    const rows = await db.timeOffRequest.findAll({
      where: { guardId: securityGuard.id, tenantId },
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    return ApiResponseHandler.success(req, res, {
      rows: rows.map((r: any) => r.get({ plain: true })),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
