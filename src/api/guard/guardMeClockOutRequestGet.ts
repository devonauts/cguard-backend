/**
 * GET /api/tenant/:tenantId/guard/me/clock-out/request
 *
 * The guard's active early-clock-out request status (pending / approved /
 * rejected) for their current open attendance record, so the app renders the
 * right clock-out UI. Returns { request: null } when there's none.
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
      return ApiResponseHandler.success(req, res, { request: null });
    }

    const activeClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
      order: [['punchInTime', 'DESC']],
      attributes: ['id'],
    });
    if (!activeClock) {
      return ApiResponseHandler.success(req, res, { request: null });
    }

    const request = await db.clockOutRequest.findOne({
      where: { guardShiftId: activeClock.id, tenantId, deletedAt: null },
      order: [['createdAt', 'DESC']],
    });

    return ApiResponseHandler.success(req, res, {
      request: request ? request.get({ plain: true }) : null,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
