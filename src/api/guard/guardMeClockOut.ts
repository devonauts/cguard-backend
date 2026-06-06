/**
 * POST /api/tenant/:tenantId/guard/me/clock-out
 * 
 * Guard clocks out. Optionally validates GPS.
 * Body: { latitude?, longitude?, observations? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { applyClockOut } from '../../services/attendanceService';

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

    // Update the clock-in record with punch-out data
    await activeClock.update({
      punchOutTime: new Date(),
      punchOutLatitude: latitude != null ? Number(latitude) : null,
      punchOutLongitude: longitude != null ? Number(longitude) : null,
      observations: observations || activeClock.observations,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: false });

    // Nómina: compute hours worked + overtime/early-departure, geofence distance,
    // persist exceptions + notify. Best-effort — never blocks the clock-out.
    try {
      const station = await db.station.findOne({
        where: { id: activeClock.stationNameId, tenantId },
      });
      await applyClockOut(db, {
        record: activeClock,
        station,
        securityGuard,
        tenantId,
        userId,
        latitude,
        longitude,
        ip: clientIp(req),
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
