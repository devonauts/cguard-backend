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
import { ymd } from './consignaRecurrence';
import { wallClockToUtc } from '../lib/tenantTime';

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
  // Dedupe in ONE query: load the OPEN exception types for this shift up front,
  // then skip in-memory (instead of a findOne per spec).
  const openTypes = new Set<string>();
  if (base.shiftId && specs.length) {
    try {
      const existing = await db.attendanceException.findAll({
        where: { tenantId: base.tenantId, shiftId: base.shiftId, status: 'open' },
        attributes: ['type'],
      });
      for (const e of existing) openTypes.add(e.type);
    } catch (e) {
      console.error('[attendance] exception dedupe load failed:', (e as any)?.message || e);
    }
  }
  for (const spec of specs) {
    try {
      if (base.shiftId && openTypes.has(spec.type)) continue;
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
    // Pre-matched scheduled shift from the caller (avoids a second 12h scan).
    sched?: { shiftId: string | null; scheduledStart: Date | null; scheduledEnd: Date | null };
  },
): Promise<string> {
  const now = opts.record.punchInTime ? new Date(opts.record.punchInTime) : new Date();
  const settings = opts.settings || (await getNominaSettings(db, opts.tenantId));
  const geofence =
    opts.geofence ||
    evaluateGeofence(opts.station, opts.latitude, opts.longitude, settings.geofence.defaultRadiusM);

  const sched =
    opts.sched ||
    (await matchScheduledShift(db, {
      guardUserId: opts.guardUserId,
      stationId: opts.station.id,
      tenantId: opts.tenantId,
      at: now,
    }));

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
  // Hours worked = SUM of each clock in/out session (excludes the gap between a
  // clock-out and a later re-clock-in within the same shift). Falls back to the
  // simple punch-in→out span when there are no sessions.
  const sessionsHrs = sessionsHoursWorked(opts.record.sessions);
  const hoursWorked =
    Array.isArray(opts.record.sessions) && opts.record.sessions.length
      ? sessionsHrs
      : evalRes.hoursWorked;
  try {
    await opts.record.update({
      hoursWorked,
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

  return { hoursWorked, status: newStatus };
}

/* ------------------------------------------------------------------------- */
/* Sessions — one attendance record per shift accumulates every in/out pair.  */
/* ------------------------------------------------------------------------- */

export interface PunchSession {
  in: string;
  inLat?: number | null;
  inLng?: number | null;
  inPhoto?: string | null;
  inAddress?: string | null;
  inBattery?: number | null;
  inDistanceM?: number | null;
  out?: string | null;
  outLat?: number | null;
  outLng?: number | null;
  outDistanceM?: number | null;
}

/** True when the last session is still open (clocked in, not yet out). */
export function hasOpenSession(record: any): boolean {
  const s = record?.sessions;
  return Array.isArray(s) && s.length > 0 && !s[s.length - 1].out;
}

/** Append a new open session (clock-in). Returns the new sessions array. */
export function appendSession(
  record: any,
  punch: {
    at: Date;
    lat?: number | null;
    lng?: number | null;
    photo?: string | null;
    address?: string | null;
    battery?: number | null;
    distanceM?: number | null;
  },
): PunchSession[] {
  const sessions: PunchSession[] = Array.isArray(record?.sessions)
    ? record.sessions.slice()
    : [];
  sessions.push({
    in: punch.at.toISOString(),
    inLat: punch.lat ?? null,
    inLng: punch.lng ?? null,
    inPhoto: punch.photo ?? null,
    inAddress: punch.address ?? null,
    inBattery: punch.battery ?? null,
    inDistanceM: punch.distanceM ?? null,
    out: null,
  });
  return sessions;
}

/** Close the last open session (clock-out). Returns the new sessions array. */
export function closeSession(
  record: any,
  punch: { at: Date; lat?: number | null; lng?: number | null; distanceM?: number | null },
): PunchSession[] {
  const sessions: PunchSession[] = Array.isArray(record?.sessions)
    ? record.sessions.slice()
    : [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (!sessions[i].out) {
      sessions[i] = {
        ...sessions[i],
        out: punch.at.toISOString(),
        outLat: punch.lat ?? null,
        outLng: punch.lng ?? null,
        outDistanceM: punch.distanceM ?? null,
      };
      break;
    }
  }
  return sessions;
}

/** Sum of (out − in) across closed sessions, in decimal hours. */
export function sessionsHoursWorked(sessions: any): number {
  if (!Array.isArray(sessions)) return 0;
  let ms = 0;
  for (const s of sessions) {
    if (s?.in && s?.out) {
      ms += Math.max(0, new Date(s.out).getTime() - new Date(s.in).getTime());
    }
  }
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/**
 * Find the existing attendance record a clock-in should append to (so in→out→in
 * within a shift reuses ONE row instead of creating duplicates). Keyed by the
 * matched scheduled shift, else by station + tenant-local calendar day.
 */
export async function findOpenOrShiftRecord(
  db: any,
  opts: {
    securityGuardId: string;
    stationId: string;
    shiftId: string | null;
    tenantId: string;
    tz: string;
    at: Date;
  },
): Promise<any | null> {
  const { securityGuardId, stationId, shiftId, tenantId, tz, at } = opts;
  if (shiftId) {
    const byShift = await db.guardShift.findOne({
      where: { guardNameId: securityGuardId, shiftId, tenantId, deletedAt: null },
      order: [['punchInTime', 'DESC']],
    });
    if (byShift) return byShift;
  }
  // Walk-up (no scheduled shift): one record per tenant-local day at the station.
  const day = ymd(at, tz);
  const start = wallClockToUtc(day, '00:00', tz);
  const end = new Date(wallClockToUtc(day, '23:59', tz).getTime() + 59_000);
  return db.guardShift.findOne({
    where: {
      guardNameId: securityGuardId,
      stationNameId: stationId,
      tenantId,
      shiftId: null,
      punchInTime: { [Op.gte]: start, [Op.lte]: end },
      deletedAt: null,
    },
    order: [['punchInTime', 'DESC']],
  });
}
