/**
 * GET /api/tenant/:tenantId/guard/me/clock-in/request?stationId=
 *
 * The guard's latest relevant late-clock-in request for TODAY (pending /
 * approved / rejected / used / expired) so the worker app can poll for the
 * supervisor's decision and unlock the clock-in button. Returns
 * { request: null } when there's none.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const stationId = req.query.stationId || null;

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

    const where: any = {
      guardUserId: userId,
      tenantId,
      createdAt: { [Op.gte]: startOfDay, [Op.lte]: endOfDay },
      deletedAt: null,
    };
    if (stationId) where.stationId = stationId;

    const request = await db.clockInRequest.findOne({
      where,
      order: [['createdAt', 'DESC']],
    });

    return ApiResponseHandler.success(req, res, {
      request: request ? request.get({ plain: true }) : null,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
