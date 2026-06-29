/**
 * Nómina / Time & Attendance settings: the per-tenant configuration that drives
 * the rules engine, geofence enforcement, notifications, approvals and payroll
 * period. Stored as JSON on `settings.nominaSettings`; this module owns the
 * defaults and the deep-merge so every consumer (rules, clock endpoints,
 * detection job, API) reads a single, fully-populated shape.
 */

export interface NominaSettings {
  general: {
    timeClockEnabled: boolean;
    timezone: string | null; // null → fall back to tenant.timezone
    requireNotesOnException: boolean;
    requireSelfie: boolean;
  };
  windows: {
    earlyClockInMin: number; // allowed minutes before shift start
    lateGraceMin: number; // grace after start before "late"
    earlyClockoutThresholdMin: number; // minutes before end that counts as early departure
    missedClockoutThresholdMin: number; // minutes after end with no clock-out → missed
    noShowThresholdMin: number; // minutes after start with no clock-in → no-call no-show
  };
  geofence: {
    defaultRadiusM: number;
    requireValidation: boolean; // block outside-geofence punches
    allowOutsideWithApproval: boolean; // allow but mark pending_review
  };
  notifications: {
    // per event-type in-app/email toggles live in the notification-channel
    // matrix (settings.notificationPreferences); these are recipient overrides.
    supervisorRecipients: boolean;
    adminRecipients: boolean;
    customEmails: string[];
    // When true, attendance-exception emails go ONLY to supervisors assigned to
    // the guard's post-site (admins/managers still always notified).
    assignedSupervisorsOnly: boolean;
  };
  approval: {
    autoApproveNormal: boolean;
    requireApprovalForExceptions: boolean;
    lockAfterPayrollClose: boolean;
    approverRoles: string[];
  };
  payroll: {
    periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    startDayOfWeek: number; // 0=Sun..6=Sat
    overtimeThresholdHours: number; // hours/shift beyond which counts as overtime
    exportFormat: 'csv' | 'pdf' | 'xlsx';
    // Optional pay rates. defaultHourlyRate = 0 → pay is NOT computed (only hours).
    currency: string;
    defaultHourlyRate: number;
    overtimeMultiplier: number;
    // Night surcharge (recargo nocturno). nightSurchargePct of the base rate is
    // added for hours worked in the night window. Ecuador default = 25%.
    nightSurchargePct: number;
    nightStartHour: number; // local hour the night window begins (default 19)
    nightEndHour: number;   // local hour the night window ends (default 6)
    lastPeriodClose: string | null; // ISO date of the last closed (locked) cutoff
    // Per-guard hourly rate overrides, keyed by securityGuard id. Falls back to
    // defaultHourlyRate when a guard has no override.
    guardRates: Record<string, number>;

    // ── Universal salary model (configured per tenant / country) ──────────────
    // 'hourly' = pay = hours × rate (legacy). 'monthly' = a fixed monthly salary per
    // guard; payroll reports days worked + hours + overtime-by-type and (optionally)
    // adjusts the salary per `unworkedDayPolicy`.
    salaryBasis: 'hourly' | 'monthly';
    defaultMonthlySalary: number;
    // Per-guard monthly salary overrides, keyed by securityGuard id.
    guardMonthlySalaries: Record<string, number>;
    // How a scheduled-but-not-worked day affects monthly pay.
    //  full = pay the full salary regardless · deduct_unjustified = subtract only
    //  unjustified-absence (no-show) days · proportional = prorate by days worked.
    unworkedDayPolicy: 'full' | 'deduct_unjustified' | 'proportional';
    // Configurable extra/overtime hour categories the company reports/pays (e.g.
    // Ecuador: suplementarias 1.5×, extraordinarias 2×). Each multiplies the base
    // hourly rate; payroll breaks hours down by these so any country's rules fit.
    extraHourTypes: Array<{ key: string; label: string; multiplier: number }>;
  };
}

export const DEFAULT_NOMINA_SETTINGS: NominaSettings = {
  general: {
    timeClockEnabled: true,
    timezone: null,
    requireNotesOnException: true,
    requireSelfie: false,
  },
  windows: {
    earlyClockInMin: 30,
    lateGraceMin: 15,
    earlyClockoutThresholdMin: 15,
    missedClockoutThresholdMin: 60,
    noShowThresholdMin: 30,
  },
  geofence: {
    defaultRadiusM: 100,
    requireValidation: true,
    allowOutsideWithApproval: false,
  },
  notifications: {
    supervisorRecipients: true,
    adminRecipients: true,
    customEmails: [],
    assignedSupervisorsOnly: false,
  },
  approval: {
    autoApproveNormal: true,
    requireApprovalForExceptions: true,
    lockAfterPayrollClose: true,
    approverRoles: ['admin', 'operationsManager', 'securitySupervisor'],
  },
  payroll: {
    periodType: 'biweekly',
    startDayOfWeek: 1,
    overtimeThresholdHours: 8,
    exportFormat: 'csv',
    currency: 'USD',
    defaultHourlyRate: 0,
    overtimeMultiplier: 1.5,
    nightSurchargePct: 0.25,
    nightStartHour: 19,
    nightEndHour: 6,
    lastPeriodClose: null,
    guardRates: {},
    salaryBasis: 'hourly',
    defaultMonthlySalary: 0,
    guardMonthlySalaries: {},
    unworkedDayPolicy: 'full',
    extraHourTypes: [
      { key: 'supplementary', label: 'Horas suplementarias', multiplier: 1.5 },
      { key: 'extraordinary', label: 'Horas extraordinarias', multiplier: 2 },
    ],
  },
};

/** Shallow-by-section merge of saved settings over defaults (one level deep). */
export function mergeNominaSettings(saved: any): NominaSettings {
  const s = saved && typeof saved === 'object' ? saved : {};
  const out: any = {};
  for (const key of Object.keys(DEFAULT_NOMINA_SETTINGS) as (keyof NominaSettings)[]) {
    out[key] = { ...(DEFAULT_NOMINA_SETTINGS[key] as any), ...(s[key] || {}) };
  }
  return out as NominaSettings;
}

/** Load + merge a tenant's Nómina settings from the settings row. */
export async function getNominaSettings(db: any, tenantId: string): Promise<NominaSettings> {
  try {
    if (!db || !tenantId) return mergeNominaSettings(null);
    const row = await db.settings.findByPk(tenantId);
    const raw = row && row.nominaSettings;
    return mergeNominaSettings(raw);
  } catch {
    return mergeNominaSettings(null);
  }
}
