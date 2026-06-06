/**
 * POST /api/tenant/:tenantId/guard/me/clock-out
 * 
 * Guard clocks out. Optionally validates GPS.
 * Body: { latitude?, longitude?, observations? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import {
  applyClockOut,
  closeSession,
  getNominaSettings,
} from '../../services/attendanceService';
import { evaluateGeofence } from '../../lib/geofence';

/** Best-effort client IP from proxy headers / socket. */
function clientIp(req: any): string | null {
  const xf = req.headers?.['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const { latitude, longitude, observations } = req.body.data || req.body;

    // Find securityGuard record
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // Find active clock-in
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

    const now = new Date();
    const station = await db.station.findOne({
      where: { id: activeClock.stationNameId, tenantId },
    });

    // ── Early clock-out gate ────────────────────────────────────────────────
    // Leaving more than the configured threshold before the scheduled end needs
    // a supervisor-approved clockOutRequest first. On-time / late / no-schedule
    // clock-outs are immediate.
    const settings = await getNominaSettings(db, tenantId);
    const thresholdMin = Number(settings?.windows?.earlyClockoutThresholdMin ?? 0);
    const scheduledEnd = activeClock.scheduledEnd
      ? new Date(activeClock.scheduledEnd)
      : null;
    const minutesEarly = scheduledEnd
      ? Math.round((scheduledEnd.getTime() - now.getTime()) / 60000)
      : 0;

    if (scheduledEnd && minutesEarly > thresholdMin) {
      const approved = await db.clockOutRequest.findOne({
        where: {
          guardShiftId: activeClock.id,
          status: 'approved',
          tenantId,
          deletedAt: null,
        },
      });
      if (!approved) {
        return ApiResponseHandler.success(req, res, {
          success: false,
          error: 'approval_required',
          requiresApproval: true,
          scheduledEnd: scheduledEnd.toISOString(),
          minutesEarly,
          thresholdMin,
          message: 'Necesitas aprobación del supervisor para salir antes de tiempo.',
        });
      }
      // Consume the approval so it can't be reused on a later re-clock-in.
      try {
        await approved.update({ status: 'cancelled', updatedById: userId });
      } catch {
        /* ignore */
      }
    }

    // Close the open session + stamp the top-level punch-out (last out).
    const distanceM = station
      ? evaluateGeofence(
          station,
          latitude != null ? Number(latitude) : null,
          longitude != null ? Number(longitude) : null,
          Number(settings?.geofence?.defaultRadiusM) || 100,
        ).distanceM
      : null;

    await activeClock.update({
      punchOutTime: now,
      punchOutLatitude: latitude != null ? Number(latitude) : null,
      punchOutLongitude: longitude != null ? Number(longitude) : null,
      observations: observations || activeClock.observations,
      sessions: closeSession(activeClock, {
        at: now,
        lat: latitude != null ? Number(latitude) : null,
        lng: longitude != null ? Number(longitude) : null,
        distanceM,
      }),
      updatedById: userId,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: false });

    // Nómina: compute hours worked (sum of sessions) + overtime/early-departure,
    // geofence distance, persist exceptions + notify. Best-effort.
    try {
      await applyClockOut(db, {
        record: activeClock,
        station,
        securityGuard,
        tenantId,
        userId,
        latitude,
        longitude,
        ip: clientIp(req),
        settings,
      });
    } catch (attErr) {
      console.error('[clockOut] attendance evaluation failed:', (attErr as any)?.message || attErr);
    }

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockOut: activeClock.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
