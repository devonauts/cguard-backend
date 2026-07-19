/**
 * POST /api/tenant/:tenantId/guard/me/clock-out/request/cancel
 *
 * The guard withdraws their open (pending) early-clock-out request, so they're
 * never stuck waiting on an approval that isn't coming. Idempotent: returns
 * { cancelled: 0 } when there's nothing pending.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { dispatch } from '../../lib/notificationDispatcher';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Capture the open pending request BEFORE the update so we can notify
    // supervisors which withdrawal happened (station + request id).
    const pending = await db.clockOutRequest.findOne({
      where: { guardId: userId, tenantId, status: 'pending', deletedAt: null },
      order: [['createdAt', 'DESC']],
    });

    const [cancelled] = await db.clockOutRequest.update(
      { status: 'cancelled', decidedAt: new Date() },
      { where: { guardId: userId, tenantId, status: 'pending', deletedAt: null } },
    );

    // CRM realtime feed (bell): mirror the create so a supervisor doesn't approve
    // a withdrawn request. Best-effort, fire-and-forget — never blocks the cancel.
    if (cancelled && pending) {
      try {
        const securityGuard = await db.securityGuard.findOne({
          where: { guardId: userId, tenantId, deletedAt: null },
          attributes: ['fullName'],
        });
        let station: any = null;
        if (pending.stationId) {
          station = await db.station.findOne({
            where: { id: pending.stationId, tenantId },
            attributes: ['stationName', 'postSiteId'],
          });
        }
        await dispatch(
          'attendance.clockout_cancelled',
          {
            guardName: (securityGuard && securityGuard.fullName) || currentUser.fullName || 'Guardia',
            stationName: (station && station.stationName) || null,
          },
          {
            database: db,
            tenantId,
            sourceEntityType: 'clockOutRequest',
            sourceEntityId: pending.id,
            assignedPostSiteId: (station && station.postSiteId) || undefined,
          },
        );
      } catch (e) {
        console.error('[clockOutRequestCancel] dispatch failed:', (e as any)?.message || e);
      }
    }

    return ApiResponseHandler.success(req, res, { ok: true, cancelled: cancelled || 0 });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
