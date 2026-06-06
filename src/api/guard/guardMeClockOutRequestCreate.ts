/**
 * POST /api/tenant/:tenantId/guard/me/clock-out/request   { reason? }
 *
 * The guard requests permission to clock out EARLY. Creates a pending
 * clockOutRequest tied to the active attendance record and notifies supervisors.
 *
 * Idempotent + retry-safe: if an open pending/approved request already exists it
 * is returned as-is. Re-requesting RE-NOTIFIES supervisors, but rate-limited to
 * once per RENOTIFY_COOLDOWN_MS so a stuck request can be nudged without looping
 * or spamming the CRM.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { dispatch } from '../../lib/notificationDispatcher';

const RENOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // re-notify supervisors at most every 5 min

/** Last time we emitted a clock-out-request notification for this request. */
async function lastNotifiedAt(db: any, requestId: string): Promise<Date | null> {
  try {
    const [rows] = await db.sequelize.query(
      `SELECT createdAt FROM platform_events
        WHERE sourceEntityId = ? AND eventType = 'attendance.clockout_requested'
        ORDER BY createdAt DESC LIMIT 1`,
      { replacements: [requestId] },
    );
    const at = (rows as any[])[0]?.createdAt;
    return at ? new Date(at) : null;
  } catch {
    return null;
  }
}

async function notifySupervisors(
  db: any,
  tenantId: string,
  request: any,
  guardName: string,
  station: any,
): Promise<void> {
  try {
    await dispatch(
      'attendance.clockout_requested',
      {
        guardName: guardName || 'Guardia',
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
}

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

    const station = await db.station.findOne({
      where: { id: activeClock.stationNameId, tenantId },
      attributes: ['id', 'stationName', 'postSiteId'],
    });

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
      // Retry path: nudge supervisors again, but only if the cooldown elapsed.
      let reNotified = false;
      if (existing.status === 'pending') {
        const last = await lastNotifiedAt(db, existing.id);
        if (!last || Date.now() - last.getTime() >= RENOTIFY_COOLDOWN_MS) {
          await notifySupervisors(db, tenantId, existing, securityGuard.fullName, station);
          reNotified = true;
        }
      }
      return ApiResponseHandler.success(req, res, {
        ...existing.get({ plain: true }),
        reNotified,
      });
    }

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

    await notifySupervisors(db, tenantId, request, securityGuard.fullName, station);

    return ApiResponseHandler.success(req, res, request.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
