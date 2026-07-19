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
import { stationIdsForGuard } from '../../services/assignedStationsService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const now = new Date();
    // Rest-day gate window (for the shiftsToday lookup below).
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    // Independent read-only lookups — run concurrently instead of sequentially
    // (this is the worker-app dashboard, hit on every mount/foreground).
    // Failure semantics preserved: shiftsToday and the Nómina settings were
    // individually try/caught before, so they resolve to null on error instead
    // of failing the whole request.
    const [securityGuard, stations, currentShift, tenant, shiftsToday, nominaSettings] =
      await Promise.all([
        // The securityGuard record for this user
        db.securityGuard.findOne({
          where: { guardId: userId, tenantId, deletedAt: null },
        }),
        // Stations assigned to this guard (guardAssignment — single source of truth)
        stationIdsForGuard(db, tenantId, userId).then((ids: string[]) =>
          ids.length
            ? db.station.findAll({
                where: { tenantId, deletedAt: null, id: ids },
                attributes: [
                  'id', 'stationName', 'latitud', 'longitud', 'stationSchedule',
                  'startingTimeInDay', 'finishTimeInDay', 'numberOfGuardsInStation',
                  'geofenceRadius', 'postSiteId',
                ],
              })
            : [],
        ),
        // Current shift for this guard
        db.shift.findOne({
          where: {
            guardId: userId,
            tenantId,
            startTime: { [Op.lte]: now },
            endTime: { [Op.gte]: now },
          },
          attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
          include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
        }),
        // Tenant timezone — the single source of truth for shift time display.
        db.tenant.findByPk(tenantId, { attributes: ['timezone'] }),
        // Today's generated shifts (clock-in eligibility / rest-day gate).
        db.shift.findAll({
          where: {
            guardId: userId,
            tenantId,
            startTime: { [Op.lte]: endOfDay },
            endTime: { [Op.gte]: startOfDay },
          },
          attributes: ['stationId'],
        }).catch(() => null),
        // Nómina settings (early-clockout threshold + grace windows). Loaded
        // ONCE per request — the clock-in-window block below reuses it.
        (async () => {
          try {
            const { getNominaSettings } = require('../../services/attendanceService');
            return await getNominaSettings(db, tenantId);
          } catch {
            return null;
          }
        })(),
      ]);

    // Dependent lookups: upcoming shift (only when none is active) + the open
    // clock-in record — independent of each other, so also concurrent.
    const [nextShift, clockIn] = await Promise.all([
      !currentShift ? db.shift.findOne({
        where: {
          guardId: userId,
          tenantId,
          startTime: { [Op.gt]: now },
        },
        attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
        include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
        order: [['startTime', 'ASC']],
      }) : Promise.resolve(null),
      securityGuard ? db.guardShift.findOne({
        where: {
          guardNameId: securityGuard.id,
          punchOutTime: null,
          tenantId,
        },
        // Skip the heavy TEXT blobs (selfies, per-session JSON, device dump):
        // the handler only reads id/scheduledEnd and the app doesn't need them
        // on the dashboard — without this every poll ships the whole row.
        attributes: {
          exclude: ['punchInPhoto', 'punchOutPhoto', 'deviceInfo', 'sessions'],
        },
        order: [['punchInTime', 'DESC']],
      }) : Promise.resolve(null),
    ]);

    // Active clock-in record (guardShift without punchOutTime)
    let activeClockIn: any = null;
    let clockOutRequest: any = null;
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
    // nominaSettings was loaded once in the parallel batch above.
    const clockOutThresholdMin = Number(nominaSettings?.windows?.earlyClockoutThresholdMin ?? 0);
    const lateGraceMin = Number(nominaSettings?.windows?.lateGraceMin ?? 5);

    // Tenant timezone is the single source of truth for shift time display.
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
    // Demo tenant: never early — the app-store reviewer clocks out at any moment
    // (the clock-out controller applies the matching bypass).
    const { configuredDemoTenantId } = require('../../services/demo/demoConstants');
    const isDemoTenant = !!tenantId && tenantId === configuredDemoTenantId();
    const isEarlyClockOut =
      !isDemoTenant &&
      !!activeClockIn &&
      minutesToScheduledEnd != null &&
      minutesToScheduledEnd > clockOutThresholdMin;

    // ── Clock-in eligibility (rest-day gate) ───────────────────────────────
    // SINGLE SOURCE OF TRUTH = the generated shift. A guard may clock in only at
    // a station where they have a SHIFT covering today. The rotation emits no
    // shift on a rest day, so this enforces rest even for permanently-assigned
    // fijos (an active assignment alone is NOT enough — Phase 7).
    // shiftsToday was loaded in the parallel batch above (null on lookup error).
    let clockInStationIds: string[] = [];
    if (shiftsToday) {
      clockInStationIds = Array.from(
        new Set(shiftsToday.map((r: any) => r.stationId).filter(Boolean)),
      );
    } else {
      // If the shift lookup fails, leave eligibility unknown rather than wrongly
      // blocking — the controller still validates on the actual punch.
      clockInStationIds = stations.map((s: any) => s.id);
    }
    // Demo tenant (sales demos + app-store review): the reviewer must always see
    // the clock-in button regardless of schedule/rest-day. The punch controller
    // applies the matching bypass. Hard-gated to DEMO_TENANT_ID.
    if (isDemoTenant) {
      clockInStationIds = Array.from(
        new Set([...clockInStationIds, ...stations.map((s: any) => s.id)]),
      );
    }
    const canClockIn = clockInStationIds.length > 0;

    // Guard profile photo (worker-app Profile screen). Prefer the guard's
    // profileImage; the clock-in selfie also lands on the user avatar.
    let guardPhotoUrl: string | null = null;
    try {
      if (securityGuard && typeof securityGuard.getProfileImage === 'function') {
        const FileRepository = require('../../database/repositories/fileRepository').default;
        const imgs = await FileRepository.fillDownloadUrl(await securityGuard.getProfileImage());
        if (Array.isArray(imgs) && imgs[0]) {
          guardPhotoUrl = imgs[0].downloadUrl || imgs[0].publicUrl || null;
        }
      }
    } catch (e) {
      // non-fatal — fall back to initials avatar
    }

    // ── Late-arrival warning for the worker app ───────────────────────────
    // Mirrors the backend detection rule: the guard has a shift active now, is
    // NOT clocked in, and we're past startTime + lateGraceMin. Null otherwise.
    let lateArrival: {
      isLate: boolean;
      lateMinutes: number;
      graceMin: number;
      shiftId: string | null;
      startTimeLabel: string | null;
      stationName: string | null;
    } | null = null;
    if (currentShift && !activeClockIn) {
      const startMs = new Date(currentShift.startTime).getTime();
      const lateMinutes = Math.max(0, Math.round((now.getTime() - startMs) / 60000));
      lateArrival = {
        // Demo tenant: the punch controller bypasses the late gate, so never flag
        // the reviewer as "late". Kept as a truthy object (isLate:false) so the
        // app takes the backend value and skips its client-side late fallback.
        isLate: !isDemoTenant && lateMinutes > lateGraceMin,
        lateMinutes,
        graceMin: lateGraceMin,
        shiftId: currentShift.id || null,
        startTimeLabel: timeLabelInTz(currentShift.startTime, tz),
        stationName: (currentShift.station && currentShift.station.stationName) || null,
      };
    }

    // ── Clock-in window hint ──────────────────────────────────────────────────
    // Best-effort pre-gate for the worker so it can disable the clock-in button
    // (and skip wasting a selfie) before calling the punch endpoint. Computed for
    // the primary clock-in target: the current shift's station if eligible, else
    // the first eligible station. Never throws.
    let clockInWindow: {
      scheduledStart: string | null;
      availableAt: string | null;
      lateAfter: string | null;
      state: 'open' | 'too_early' | 'late' | 'none';
    } = { scheduledStart: null, availableAt: null, lateAfter: null, state: 'none' };
    try {
      const targetStationId =
        (currentShift && clockInStationIds.includes(currentShift.stationId)
          ? currentShift.stationId
          : clockInStationIds[0]) || null;
      if (targetStationId && !activeClockIn) {
        const { matchScheduledShift, getNominaSettings } = require('../../services/attendanceService');
        // Reuse the settings loaded in the parallel batch above — this used to
        // be a second findByPk of the same row within one request.
        const settings = nominaSettings ?? (await getNominaSettings(db, tenantId));
        const [targetStation, match] = await Promise.all([
          db.station.findOne({
            where: { id: targetStationId, tenantId, deletedAt: null },
            attributes: ['id', 'clockInEarlyBufferMin', 'clockInLateGraceMin'],
          }),
          matchScheduledShift(db, {
            guardUserId: userId,
            stationId: targetStationId,
            tenantId,
            at: now,
          }),
        ]);
        if (match.scheduledStart) {
          const effectiveEarly = targetStation && targetStation.clockInEarlyBufferMin != null
            ? Number(targetStation.clockInEarlyBufferMin)
            : Number(settings.windows.earlyClockInMin);
          const effectiveLate = targetStation && targetStation.clockInLateGraceMin != null
            ? Number(targetStation.clockInLateGraceMin)
            : Number(settings.windows.lateGraceMin);
          const scheduledStart = new Date(match.scheduledStart);
          const windowOpen = new Date(scheduledStart.getTime() - effectiveEarly * 60000);
          const lateLimit = new Date(scheduledStart.getTime() + effectiveLate * 60000);
          const state: 'open' | 'too_early' | 'late' =
            now < windowOpen ? 'too_early' : now > lateLimit ? 'late' : 'open';
          clockInWindow = {
            scheduledStart: scheduledStart.toISOString(),
            availableAt: windowOpen.toISOString(),
            lateAfter: lateLimit.toISOString(),
            state,
          };
        }
      }
    } catch {
      /* best-effort — leave default { state: 'none' } */
    }
    // Demo tenant (sales demos / app-store review): the punch controller bypasses
    // the clock-in window + late gate, so surface an OPEN window to the app —
    // otherwise it shows the late-approval flow ("Solicitar entrada") and blocks a
    // direct clock-in the backend would actually accept.
    if (isDemoTenant) clockInWindow = { ...clockInWindow, state: 'open' };

    const response = {
      timezone: tz,
      canClockIn,
      clockInStationIds,
      clockInWindow,
      guard: securityGuard ? {
        id: securityGuard.id,
        fullName: securityGuard.fullName,
        isOnDuty: securityGuard.isOnDuty,
        guardType: securityGuard.guardType,
        guardId: securityGuard.guardId,
        // Profile fields (worker-app Profile screen).
        photoUrl: guardPhotoUrl,
        // NOTE: do NOT expose governmentId here — it's the national ID document,
        // not an employee code. The app derives a non-sensitive internal code
        // from guardId.
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
      lateArrival,
    };

    return ApiResponseHandler.success(req, res, response);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
