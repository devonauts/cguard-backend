/**
 * Attendance rules engine.
 *
 * Pure, config-driven evaluators (all thresholds come from NominaSettings) so a
 * new rule is added by writing one function + one setting — never by rewriting
 * the clock endpoints or the detection job. Three entry points:
 *   - evaluateClockIn  → status/lateness/geofence at punch-in
 *   - evaluateClockOut → hours/overtime/early-departure at punch-out
 *   - detectForShift   → late / no-show / missed-clockout for the background job
 *
 * Statuses: on_time | late | early_departure | missed_clockin | missed_clockout
 *           | no_call_no_show | overtime | pending_review | approved | rejected
 */

import { NominaSettings } from './nominaSettings';

export interface ExceptionSpec {
  type:
    | 'late_arrival'
    | 'early_departure'
    | 'missed_clockin'
    | 'missed_clockout'
    | 'no_call_no_show'
    | 'outside_geofence'
    | 'overtime'
    | 'correction_pending';
  severity: 'low' | 'medium' | 'high' | 'critical';
  reason?: string;
  meta?: Record<string, any>;
}

const minutesBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60000);

export interface ClockInEval {
  status: string;
  lateMinutes: number;
  pendingReview: boolean;
  exceptions: ExceptionSpec[];
}

/** Evaluate a punch-in against the schedule + geofence. */
export function evaluateClockIn(
  ctx: {
    now: Date;
    scheduledStart: Date | null;
    distanceM: number | null;
    outsideGeofence: boolean;
  },
  settings: NominaSettings,
): ClockInEval {
  const exceptions: ExceptionSpec[] = [];
  let status = 'on_time';
  let lateMinutes = 0;
  let pendingReview = false;

  // Lateness
  if (ctx.scheduledStart) {
    const late = minutesBetween(ctx.now, ctx.scheduledStart);
    if (late > settings.windows.lateGraceMin) {
      lateMinutes = late;
      status = 'late';
      exceptions.push({
        type: 'late_arrival',
        severity: late > settings.windows.lateGraceMin * 2 ? 'high' : 'medium',
        reason: `Llegó ${late} min después del inicio del turno`,
        meta: { lateMinutes: late, graceMin: settings.windows.lateGraceMin },
      });
    }
  }

  // Outside geofence (only reached here when the punch was allowed through —
  // i.e. allowOutsideWithApproval; hard-blocked punches never create a record).
  if (ctx.outsideGeofence) {
    pendingReview = true;
    status = 'pending_review';
    exceptions.push({
      type: 'outside_geofence',
      severity: 'high',
      reason:
        ctx.distanceM != null
          ? `Marcó entrada a ${ctx.distanceM} m del puesto`
          : 'Marcó entrada fuera del área permitida',
      meta: { distanceM: ctx.distanceM },
    });
  }

  return { status, lateMinutes, pendingReview, exceptions };
}

export interface ClockOutEval {
  /** New status, or null to keep the existing record status. */
  status: string | null;
  hoursWorked: number;
  overtimeMinutes: number;
  earlyDepartureMinutes: number;
  pendingReview: boolean;
  exceptions: ExceptionSpec[];
}

/** Evaluate a punch-out: hours worked, overtime, early departure, geofence. */
export function evaluateClockOut(
  ctx: {
    now: Date;
    punchInTime: Date;
    scheduledEnd: Date | null;
    distanceM: number | null;
    outsideGeofence: boolean;
  },
  settings: NominaSettings,
): ClockOutEval {
  const exceptions: ExceptionSpec[] = [];
  let status: string | null = null;
  let pendingReview = false;

  // Hours worked (overnight-safe: both are absolute timestamps).
  const rawMinutes = Math.max(0, minutesBetween(ctx.now, ctx.punchInTime));
  const hoursWorked = Math.round((rawMinutes / 60) * 100) / 100;

  // Early departure
  let earlyDepartureMinutes = 0;
  if (ctx.scheduledEnd) {
    const early = minutesBetween(ctx.scheduledEnd, ctx.now);
    if (early > settings.windows.earlyClockoutThresholdMin) {
      earlyDepartureMinutes = early;
      status = 'early_departure';
      exceptions.push({
        type: 'early_departure',
        severity: 'medium',
        reason: `Marcó salida ${early} min antes del fin del turno`,
        meta: { earlyMinutes: early },
      });
    }
  }

  // Overtime
  let overtimeMinutes = 0;
  if (ctx.scheduledEnd) {
    const over = minutesBetween(ctx.now, ctx.scheduledEnd);
    if (over > 0) overtimeMinutes = over;
  } else if (hoursWorked > settings.payroll.overtimeThresholdHours) {
    overtimeMinutes = Math.round((hoursWorked - settings.payroll.overtimeThresholdHours) * 60);
  }
  if (overtimeMinutes > 0 && status == null) {
    status = 'overtime';
    exceptions.push({
      type: 'overtime',
      severity: 'low',
      reason: `${overtimeMinutes} min de tiempo extra`,
      meta: { overtimeMinutes },
    });
  }

  // Outside geofence on the way out.
  if (ctx.outsideGeofence) {
    pendingReview = true;
    status = 'pending_review';
    exceptions.push({
      type: 'outside_geofence',
      severity: 'high',
      reason:
        ctx.distanceM != null
          ? `Marcó salida a ${ctx.distanceM} m del puesto`
          : 'Marcó salida fuera del área permitida',
      meta: { distanceM: ctx.distanceM, phase: 'clockout' },
    });
  }

  return { status, hoursWorked, overtimeMinutes, earlyDepartureMinutes, pendingReview, exceptions };
}

/**
 * Detection for the background job: given a scheduled shift and whether the
 * guard has clocked in/out, decide which (if any) exception applies *right now*.
 * Returns at most one spec; the job dedupes by (shiftId, type).
 */
export function detectForShift(
  ctx: {
    now: Date;
    shiftStart: Date;
    shiftEnd: Date;
    hasClockIn: boolean;
    hasClockOut: boolean;
  },
  settings: NominaSettings,
): ExceptionSpec | null {
  // No clock-in yet.
  if (!ctx.hasClockIn) {
    const since = minutesBetween(ctx.now, ctx.shiftStart);
    if (since > settings.windows.noShowThresholdMin) {
      return {
        type: 'no_call_no_show',
        severity: 'critical',
        reason: `Sin marcar entrada ${since} min después del inicio`,
        meta: { minutesLate: since, threshold: settings.windows.noShowThresholdMin },
      };
    }
    if (since > settings.windows.lateGraceMin) {
      return {
        type: 'late_arrival',
        severity: 'medium',
        reason: `Aún sin marcar entrada (${since} min tarde)`,
        meta: { minutesLate: since, graceMin: settings.windows.lateGraceMin },
      };
    }
    return null;
  }

  // Clocked in but never out, and the shift ended past the threshold.
  if (ctx.hasClockIn && !ctx.hasClockOut) {
    const past = minutesBetween(ctx.now, ctx.shiftEnd);
    if (past > settings.windows.missedClockoutThresholdMin) {
      return {
        type: 'missed_clockout',
        severity: 'high',
        reason: `Sin marcar salida ${past} min después del fin del turno`,
        meta: { minutesPast: past, threshold: settings.windows.missedClockoutThresholdMin },
      };
    }
  }

  return null;
}

/** Map an exception type → a notification event type. */
export const EXCEPTION_EVENT: Record<string, string> = {
  late_arrival: 'attendance.late',
  no_call_no_show: 'attendance.no_show',
  outside_geofence: 'attendance.outside_geofence',
  early_departure: 'attendance.early_departure',
  missed_clockout: 'attendance.missed_clockout',
  overtime: 'attendance.late', // reuse late row; overtime is informational
  correction_pending: 'attendance.correction_submitted',
};
