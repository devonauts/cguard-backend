/**
 * Attendance service — the single place that turns a clock-in/out punch into a
 * fully-evaluated attendance record: match the scheduled shift, compute geofence
 * distance, run the rules engine, persist exceptions, and notify. Used by the
 * worker-app and (Phase 2) web clock endpoints, plus the detection job. Plain
 * functions (like lib/clockInContext.ts) so any req.database caller can use it.
 *
 * All times are UTC. Notification/exception writes are best-effort — they never
 * block or fail a punch.
 */

import { Op } from 'sequelize';
import { evaluateGeofence, GeofenceResult } from '../lib/geofence';
import { getNominaSettings, NominaSettings } from '../lib/nominaSettings';
import {
  evaluateClockIn,
  evaluateClockOut,
  ExceptionSpec,
  EXCEPTION_EVENT,
} from '../lib/attendanceRules';
import { dispatch } from '../lib/notificationDispatcher';

export { getNominaSettings };

/** Find the scheduled shift a punch fulfills (guard user + station near `at`). */
export async function matchScheduledShift(
  db: any,
  opts: { guardUserId: string; stationId: string; tenantId: string; at: Date },
): Promise<{ shiftId: string | null; scheduledStart: Date | null; scheduledEnd: Date | null }> {
  try {
    const { guardUserId, stationId, tenantId, at } = opts;
    const windowStart = new Date(at.getTime() - 12 * 3600 * 1000);
    const windowEnd = new Date(at.getTime() + 12 * 3600 * 1000);
    const rows = await db.shift.findAll({
      where: {
        guardId: guardUserId,
        stationId,
        tenantId,
        startTime: { [Op.lte]: windowEnd },
        endTime: { [Op.gte]: windowStart },
      },
      attributes: ['id', 'startTime', 'endTime'],
      order: [['startTime', 'ASC']],
    });
    if (!rows.length) return { shiftId: null, scheduledStart: null, scheduledEnd: null };
    // Prefer the shift currently covering `at`; else the one starting nearest it.
    const covering = rows.find(
      (r: any) => new Date(r.startTime) <= at && new Date(r.endTime) >= at,
    );
    const pick =
      covering ||
      rows.reduce((best: any, r: any) =>
        Math.abs(new Date(r.startTime).getTime() - at.getTime()) <
        Math.abs(new Date(best.startTime).getTime() - at.getTime())
          ? r
          : best,
      );
    return {
      shiftId: pick.id,
      scheduledStart: new Date(pick.startTime),
      scheduledEnd: new Date(pick.endTime),
    };
  } catch {
    return { shiftId: null, scheduledStart: null, scheduledEnd: null };
  }
}

/**
 * Geofence/eligibility gate for the punch endpoint. Returns the computed
 * distance plus whether the punch should be BLOCKED. Blocking applies only when
 * the tenant requires validation, does NOT allow outside-with-approval, and the
 * coords are computably outside the radius.
 */
export async function clockGate(
  db: any,
  tenantId: string,
  station: any,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  settings?: NominaSettings,
): Promise<{ settings: NominaSettings; geofence: GeofenceResult; blocked: boolean }> {
  const s = settings || (await getNominaSettings(db, tenantId));
  const geofence = evaluateGeofence(station, latitude, longitude, s.geofence.defaultRadiusM);
  const blocked =
    geofence.outside && s.geofence.requireValidation && !s.geofence.allowOutsideWithApproval;
  return { settings: s, geofence, blocked };
}

/** Persist exception rows, deduping by (shiftId,type) when a shift is known. */
async function recordExceptions(
  db: any,
  base: {
    tenantId: string;
    userId: string;
    guardShiftId: string | null;
    shiftId: string | null;
    guardId: string | null; // securityGuard id
    stationId: string | null;
    postSiteId: string | null;
  },
  specs: ExceptionSpec[],
): Promise<any[]> {
  const created: any[] = [];
  for (const spec of specs) {
    try {
      // Dedupe: skip if an OPEN exception already exists for this shift+type.
      if (base.shiftId) {
        const existing = await db.attendanceException.findOne({
          where: { tenantId: base.tenantId, shiftId: base.shiftId, type: spec.type, status: 'open' },
          attributes: ['id'],
        });
        if (existing) continue;
      }
      const row = await db.attendanceException.create({
        type: spec.type,
        severity: spec.severity,
        status: 'open',
        reason: spec.reason || null,
        meta: spec.meta || null,
        detectedAt: new Date(),
        guardShiftId: base.guardShiftId,
        shiftId: base.shiftId,
        guardId: base.guardId,
        stationId: base.stationId,
        postSiteId: base.postSiteId,
        tenantId: base.tenantId,
        createdById: base.userId,
        updatedById: base.userId,
      });
      created.push(row);
    } catch (e) {
      console.error('[attendance] recordException failed:', (e as any)?.message || e);
    }
  }
  return created;
}

/** Notify supervisors/admins (+ custom emails) about an exception. */
async function notifyException(
  db: any,
  tenantId: string,
  settings: NominaSettings,
  exceptionRow: any,
  data: Record<string, any>,
): Promise<void> {
  const eventType = EXCEPTION_EVENT[exceptionRow.type];
  if (!eventType) return;
  try {
    await dispatch(eventType, data, {
      database: db,
      tenantId,
      sourceEntityType: 'attendanceException',
      sourceEntityId: exceptionRow.id,
      extraEmails: settings.notifications.customEmails || [],
      // Narrow to the post-site's assigned supervisors when enabled.
      assignedPostSiteId:
        settings.notifications.assignedSupervisorsOnly && exceptionRow.postSiteId
          ? exceptionRow.postSiteId
          : undefined,
    });
  } catch (e) {
    console.error('[attendance] notifyException failed:', (e as any)?.message || e);
  }
}

/**
 * Apply attendance evaluation to a freshly-created clock-in record. Mutates +
 * saves the guardShift row with status/scheduled snapshot/distance/flags/device,
 * persists exceptions, and notifies. Returns the resolved status.
 */
export async function applyClockIn(
  db: any,
  opts: {
    record: any; // guardShift instance
    station: any;
    securityGuard: any;
    guardUserId: string;
    tenantId: string;
    userId: string;
    latitude: number | null | undefined;
    longitude: number | null | undefined;
    deviceInfo?: any;
    ip?: string | null;
    settings?: NominaSettings;
    geofence?: GeofenceResult;
  },
): Promise<string> {
  const now = opts.record.punchInTime ? new Date(opts.record.punchInTime) : new Date();
  const settings = opts.settings || (await getNominaSettings(db, opts.tenantId));
  const geofence =
    opts.geofence ||
    evaluateGeofence(opts.station, opts.latitude, opts.longitude, settings.geofence.defaultRadiusM);

  const sched = await matchScheduledShift(db, {
    guardUserId: opts.guardUserId,
    stationId: opts.station.id,
    tenantId: opts.tenantId,
    at: now,
  });

  const evalRes = evaluateClockIn(
    { now, scheduledStart: sched.scheduledStart, distanceM: geofence.distanceM, outsideGeofence: geofence.outside },
    settings,
  );

  try {
    await opts.record.update({
      shiftId: sched.shiftId,
      scheduledStart: sched.scheduledStart,
      scheduledEnd: sched.scheduledEnd,
      status: evalRes.status,
      lateMinutes: evalRes.lateMinutes,
      punchInDistanceM: geofence.distanceM,
      punchInOutsideGeofence: geofence.outside,
      deviceInfo: opts.deviceInfo ? JSON.stringify(opts.deviceInfo) : opts.record.deviceInfo,
      punchInIp: opts.ip || null,
    });
  } catch (e) {
    console.error('[attendance] applyClockIn update failed:', (e as any)?.message || e);
  }

  const rows = await recordExceptions(
    db,
    {
      tenantId: opts.tenantId,
      userId: opts.userId,
      guardShiftId: opts.record.id,
      shiftId: sched.shiftId,
      guardId: opts.securityGuard?.id || null,
      stationId: opts.station.id,
      postSiteId: opts.station.postSiteId || null,
    },
    evalRes.exceptions,
  );

  for (const row of rows) {
    await notifyException(db, opts.tenantId, settings, row, {
      guardName: opts.securityGuard?.fullName || 'Guardia',
      stationName: opts.station?.stationName || null,
      reason: row.reason,
      type: row.type,
      distanceM: geofence.distanceM,
    });
  }

  return evalRes.status;
}

/**
 * Apply attendance evaluation to a clock-out. Mutates + saves the guardShift
 * row with hoursWorked/overtime/early-departure/status/distance, persists
 * exceptions, and notifies. Returns the computed { hoursWorked, status }.
 */
export async function applyClockOut(
  db: any,
  opts: {
    record: any; // guardShift instance (already has punchOutTime set)
    station: any;
    securityGuard?: any;
    tenantId: string;
    userId: string;
    latitude: number | null | undefined;
    longitude: number | null | undefined;
    ip?: string | null;
    settings?: NominaSettings;
    geofence?: GeofenceResult;
  },
): Promise<{ hoursWorked: number; status: string }> {
  const settings = opts.settings || (await getNominaSettings(db, opts.tenantId));
  const geofence =
    opts.geofence ||
    evaluateGeofence(opts.station, opts.latitude, opts.longitude, settings.geofence.defaultRadiusM);

  const punchIn = new Date(opts.record.punchInTime);
  const now = opts.record.punchOutTime ? new Date(opts.record.punchOutTime) : new Date();

  const evalRes = evaluateClockOut(
    {
      now,
      punchInTime: punchIn,
      scheduledEnd: opts.record.scheduledEnd ? new Date(opts.record.scheduledEnd) : null,
      distanceM: geofence.distanceM,
      outsideGeofence: geofence.outside,
    },
    settings,
  );

  const newStatus = evalRes.status || opts.record.status || 'on_time';
  try {
    await opts.record.update({
      hoursWorked: evalRes.hoursWorked,
      overtimeMinutes: evalRes.overtimeMinutes,
      earlyDepartureMinutes: evalRes.earlyDepartureMinutes,
      status: newStatus,
      punchOutDistanceM: geofence.distanceM,
      punchOutOutsideGeofence: geofence.outside,
      punchOutIp: opts.ip || null,
    });
  } catch (e) {
    console.error('[attendance] applyClockOut update failed:', (e as any)?.message || e);
  }

  const guardId =
    opts.securityGuard?.id || opts.record.guardNameId || null;
  const rows = await recordExceptions(
    db,
    {
      tenantId: opts.tenantId,
      userId: opts.userId,
      guardShiftId: opts.record.id,
      shiftId: opts.record.shiftId || null,
      guardId,
      stationId: opts.record.stationNameId || opts.station?.id || null,
      postSiteId: opts.record.postSiteId || opts.station?.postSiteId || null,
    },
    evalRes.exceptions,
  );

  for (const row of rows) {
    await notifyException(db, opts.tenantId, settings, row, {
      guardName: opts.securityGuard?.fullName || 'Guardia',
      stationName: opts.station?.stationName || null,
      reason: row.reason,
      type: row.type,
      distanceM: geofence.distanceM,
    });
  }

  return { hoursWorked: evalRes.hoursWorked, status: newStatus };
}
