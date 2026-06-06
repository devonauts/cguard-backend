/**
 * POST /api/tenant/:tenantId/guard/me/clock-out/request   { reason? }
 *
 * The guard requests permission to clock out EARLY. Creates a pending
 * clockOutRequest tied to the active attendance record and notifies supervisors.
 * Idempotent: returns the existing pending request if one is open.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { dispatch } from '../../lib/notificationDispatcher';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const data = (req.body && req.body.data) || req.body || {};

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    if (!securityGuard) throw new Error400(req.language, 'guard.profileNotFound');

    // The active (open) attendance record.
    const activeClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
      order: [['punchInTime', 'DESC']],
    });
    if (!activeClock) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'not_clocked_in',
        message: 'No tienes un registro de entrada activo.',
      });
    }

    // Reuse an open pending/approved request for this record.
    const existing = await db.clockOutRequest.findOne({
      where: {
        guardShiftId: activeClock.id,
        tenantId,
        status: ['pending', 'approved'],
        deletedAt: null,
      },
      order: [['createdAt', 'DESC']],
    });
    if (existing) {
      return ApiResponseHandler.success(req, res, existing.get({ plain: true }));
    }

    const station = await db.station.findOne({
      where: { id: activeClock.stationNameId, tenantId },
      attributes: ['id', 'stationName', 'postSiteId'],
    });

    const request = await db.clockOutRequest.create({
      guardId: userId,
      securityGuardId: securityGuard.id,
      guardShiftId: activeClock.id,
      shiftId: activeClock.shiftId || null,
      stationId: activeClock.stationNameId || null,
      scheduledEnd: activeClock.scheduledEnd || null,
      reason: data.reason ? String(data.reason).slice(0, 500) : null,
      requestedAt: new Date(),
      status: 'pending',
      tenantId,
      createdById: userId,
    });

    // Notify supervisors (assigned-post-site scoped, like other attendance events).
    try {
      await dispatch(
        'attendance.clockout_requested',
        {
          guardName: securityGuard.fullName || 'Guardia',
          stationName: station?.stationName || null,
          reason: request.reason || null,
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'clockOutRequest',
          sourceEntityId: request.id,
          assignedPostSiteId: station?.postSiteId || undefined,
        },
      );
    } catch (e) {
      console.error('[clockOutRequest] dispatch failed:', (e as any)?.message || e);
    }

    return ApiResponseHandler.success(req, res, request.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
