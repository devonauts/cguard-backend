/**
 * GET /api/tenant/:tenantId/guard/me
 * 
 * Returns the guard's dashboard: assigned station(s), current shift status,
 * active guardShift (clock-in record), and station schedule.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Roles from '../../security/roles';
import { Op } from 'sequelize';
import { timeLabelInTz } from '../../lib/tenantTime';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Find the securityGuard record for this user
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    // Find stations assigned to this guard (via junction table)
    const stations = await db.station.findAll({
      where: { tenantId, deletedAt: null },
      include: [{
        model: db.user,
        as: 'assignedGuards',
        where: { id: userId },
        attributes: [],
        through: { attributes: [] },
      }],
      attributes: [
        'id', 'stationName', 'latitud', 'longitud', 'stationSchedule',
        'startingTimeInDay', 'finishTimeInDay', 'numberOfGuardsInStation',
        'geofenceRadius', 'postSiteId',
      ],
    });

    // Current/upcoming shift for this guard
    const now = new Date();
    const currentShift = await db.shift.findOne({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.lte]: now },
        endTime: { [Op.gte]: now },
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
    });

    const nextShift = !currentShift ? await db.shift.findOne({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.gt]: now },
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
      order: [['startTime', 'ASC']],
    }) : null;

    // Active clock-in record (guardShift without punchOutTime)
    let activeClockIn: any = null;
    let clockOutRequest: any = null;
    if (securityGuard) {
      const clockIn = await db.guardShift.findOne({
        where: {
          guardNameId: securityGuard.id,
          punchOutTime: null,
          tenantId,
        },
        order: [['punchInTime', 'DESC']],
      });
      if (clockIn) {
        activeClockIn = clockIn.get({ plain: true });
        // The early-clock-out approval state for this open record (drives the
        // worker-app clock-out button: request → pending → approved).
        try {
          const reqRow = await db.clockOutRequest.findOne({
            where: { guardShiftId: clockIn.id, tenantId, deletedAt: null },
            order: [['createdAt', 'DESC']],
            attributes: ['id', 'status', 'scheduledEnd', 'reason', 'decisionNotes'],
          });
          if (reqRow) clockOutRequest = reqRow.get({ plain: true });
        } catch {
          /* ignore */
        }
      }
    }

    // Self-heal the denormalized securityGuard.isOnDuty flag against the source
    // of truth (an open guardShift). If a prior clock-in/out half-completed and
    // left the flag stale, this corrects it on the next dashboard load.
    if (securityGuard && !!securityGuard.isOnDuty !== !!activeClockIn) {
      const onDuty = !!activeClockIn;
      securityGuard.isOnDuty = onDuty;
      db.securityGuard
        .update({ isOnDuty: onDuty }, { where: { id: securityGuard.id, tenantId } })
        .catch(() => {});
    }

    // Early-clockout threshold (minutes before scheduled end that requires
    // approval) so the app can decide whether to show "request" vs "clock out".
    let clockOutThresholdMin = 0;
    try {
      const { getNominaSettings } = require('../../services/attendanceService');
      const settings = await getNominaSettings(db, tenantId);
      clockOutThresholdMin = Number(settings?.windows?.earlyClockoutThresholdMin ?? 0);
    } catch {
      /* ignore */
    }

    // Tenant timezone is the single source of truth for shift time display.
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenant && tenant.timezone) || 'UTC';
    const withLabels = (s: any) => {
      if (!s) return null;
      const p = s.get({ plain: true });
      return { ...p, startTimeLabel: timeLabelInTz(p.startTime, tz), endTimeLabel: timeLabelInTz(p.endTime, tz) };
    };

    // ── Early-clock-out decision — derived from the TURNO (single source of
    // truth) so the post stays covered until its scheduled end. The guard may
    // clock out normally only once they're within `clockOutThresholdMin` of the
    // turno's end; leaving earlier requires supervisor approval.
    //   scheduledEnd = the attendance record's captured end (set at clock-in from
    //   the matched shift) → else the currently-active turno's endTime.
    const scheduledEndRaw =
      (activeClockIn && activeClockIn.scheduledEnd) ||
      (currentShift && currentShift.endTime) ||
      null;
    const scheduledEnd = scheduledEndRaw ? new Date(scheduledEndRaw) : null;
    const minutesToScheduledEnd =
      scheduledEnd != null ? (scheduledEnd.getTime() - now.getTime()) / 60000 : null;
    // Early only when we KNOW the turno end and there's still more than the grace
    // window left. With no turno end we can't enforce a desired time → not early.
    const isEarlyClockOut =
      !!activeClockIn &&
      minutesToScheduledEnd != null &&
      minutesToScheduledEnd > clockOutThresholdMin;

    // ── Clock-in eligibility (rest-day gate) ───────────────────────────────
    // SINGLE SOURCE OF TRUTH = the generated shift. A guard may clock in only at
    // a station where they have a SHIFT covering today. The rotation emits no
    // shift on a rest day, so this enforces rest even for permanently-assigned
    // fijos (an active assignment alone is NOT enough — Phase 7).
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    let clockInStationIds: string[] = [];
    try {
      const shiftsToday = await db.shift.findAll({
        where: {
          guardId: userId,
          tenantId,
          startTime: { [Op.lte]: endOfDay },
          endTime: { [Op.gte]: startOfDay },
        },
        attributes: ['stationId'],
      });
      clockInStationIds = Array.from(
        new Set(shiftsToday.map((r: any) => r.stationId).filter(Boolean)),
      );
    } catch {
      // If the shift lookup fails, leave eligibility unknown rather than wrongly
      // blocking — the controller still validates on the actual punch.
      clockInStationIds = stations.map((s: any) => s.id);
    }
    const canClockIn = clockInStationIds.length > 0;

    const response = {
      timezone: tz,
      canClockIn,
      clockInStationIds,
      guard: securityGuard ? {
        id: securityGuard.id,
        fullName: securityGuard.fullName,
        isOnDuty: securityGuard.isOnDuty,
        guardType: securityGuard.guardType,
        guardId: securityGuard.guardId,
        // Profile fields (worker-app Profile screen).
        employeeId: securityGuard.governmentId || null,
        joinedAt: securityGuard.hiringContractDate || null,
        address: securityGuard.address || null,
        email: (req.currentUser && req.currentUser.email) || null,
        phone: (req.currentUser && req.currentUser.phoneNumber) || null,
      } : null,
      stations: stations.map((s: any) => s.get({ plain: true })),
      currentShift: withLabels(currentShift),
      nextShift: withLabels(nextShift),
      activeClockIn,
      isClockedIn: !!activeClockIn,
      clockOutRequest, // { status, scheduledEnd, … } or null — early-out approval
      clockOutThresholdMin,
      // Turno-derived clock-out gating (single source of truth).
      scheduledEnd: scheduledEnd ? scheduledEnd.toISOString() : null,
      scheduledEndLabel: scheduledEnd ? timeLabelInTz(scheduledEnd, tz) : null,
      minutesToScheduledEnd:
        minutesToScheduledEnd != null ? Math.round(minutesToScheduledEnd) : null,
      isEarlyClockOut,
    };

    return ApiResponseHandler.success(req, res, response);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
