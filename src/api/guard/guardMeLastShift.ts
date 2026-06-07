/**
 * GET /api/tenant/:tenantId/guard/me/last-shift
 *
 * Summary of the guard's most recent COMPLETED shift, for the off-duty
 * "last shift" card: duration, checkpoints scanned, incidents logged, and
 * distance patrolled. Prefers the snapshot captured at clock-out
 * (guardShift.checkpointsScanned/incidentsLogged/distanceMeters); for a shift
 * that predates the snapshot those are NULL, so we recompute them live.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import { timeLabelInTz } from '../../lib/tenantTime';
import { computeShiftMetrics } from '../../services/attendanceService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });
    if (!securityGuard) {
      return ApiResponseHandler.success(req, res, { hasData: false });
    }

    // Most recent shift that has been clocked out.
    const shift = await db.guardShift.findOne({
      where: {
        guardNameId: securityGuard.id,
        tenantId,
        punchOutTime: { [Op.ne]: null },
        deletedAt: null,
      },
      order: [['punchOutTime', 'DESC']],
      include: [
        { model: db.station, as: 'stationName', attributes: ['stationName'], required: false },
      ],
    });

    if (!shift) {
      return ApiResponseHandler.success(req, res, { hasData: false });
    }

    const punchInTime = shift.punchInTime ? new Date(shift.punchInTime) : null;
    const punchOutTime = shift.punchOutTime ? new Date(shift.punchOutTime) : null;

    // Prefer the clock-out snapshot; recompute live only when it's missing.
    let checkpoints = shift.checkpointsScanned;
    let incidents = shift.incidentsLogged;
    let distanceMeters = shift.distanceMeters;
    if (
      (checkpoints == null || incidents == null || distanceMeters == null) &&
      punchInTime &&
      punchOutTime
    ) {
      const m = await computeShiftMetrics(db, {
        guardId: securityGuard.id,
        tenantId,
        punchInTime,
        punchOutTime,
        punchInLat: shift.punchInLatitude,
        punchInLng: shift.punchInLongitude,
        punchOutLat: shift.punchOutLatitude,
        punchOutLng: shift.punchOutLongitude,
      });
      if (checkpoints == null) checkpoints = m.checkpointsScanned;
      if (incidents == null) incidents = m.incidentsLogged;
      if (distanceMeters == null) distanceMeters = m.distanceMeters;
    }

    // Duration: prefer the persisted hoursWorked, else the punch span.
    let durationMinutes = 0;
    if (shift.hoursWorked != null) {
      durationMinutes = Math.round(Number(shift.hoursWorked) * 60);
    } else if (punchInTime && punchOutTime) {
      durationMinutes = Math.max(0, Math.round((punchOutTime.getTime() - punchInTime.getTime()) / 60000));
    }

    const tz = req.currentTenant?.timezone || undefined;

    return ApiResponseHandler.success(req, res, {
      hasData: true,
      shiftId: shift.id,
      punchInTime: shift.punchInTime,
      punchOutTime: shift.punchOutTime,
      punchOutLabel: punchOutTime ? timeLabelInTz(punchOutTime, tz) : null,
      stationName: shift.stationName?.stationName || null,
      durationMinutes,
      checkpoints: checkpoints || 0,
      incidents: incidents || 0,
      distanceMeters: distanceMeters || 0,
      distanceKm: Math.round(((distanceMeters || 0) / 1000) * 10) / 10,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
