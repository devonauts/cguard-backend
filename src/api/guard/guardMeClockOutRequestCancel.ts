/**
 * POST /api/tenant/:tenantId/guard/me/clock-out/request/cancel
 *
 * The guard withdraws their open (pending) early-clock-out request, so they're
 * never stuck waiting on an approval that isn't coming. Idempotent: returns
 * { cancelled: 0 } when there's nothing pending.
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

    const [cancelled] = await db.clockOutRequest.update(
      { status: 'cancelled', decidedAt: new Date() },
      { where: { guardId: userId, tenantId, status: 'pending', deletedAt: null } },
    );

    return ApiResponseHandler.success(req, res, { ok: true, cancelled: cancelled || 0 });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
