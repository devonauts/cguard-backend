/**
 * Configuración Global de Vigilantes (Configuración › keep-safe).
 *
 * Stored as JSON in settings.guardSettings (missing key = default, so new
 * options ship without migrations). Written from the CRM through the normal
 * settings PUT; enforced server-side:
 *   - inactivityAlert* → guardInactivityService sweep (5 min, leader)
 *   - shiftRemindersEnabled → shiftReminderService per-tenant skip
 *   - licenseExpiry* → licenseExpiryService daily sweep
 */

export interface GuardSettings {
  /** Alert supervisors when an ON-DUTY guard's device goes silent. */
  inactivityAlert: boolean;
  /** Minutes without any GPS ping before alerting (10–120). */
  inactivityThresholdMin: number;
  /** Push/WhatsApp shift reminders (2d/1d/12h/1h/10m before start). */
  shiftRemindersEnabled: boolean;
  /** Notify HR when guard credentials/licenses approach expiry. */
  licenseExpiryAlert: boolean;
  /** Days before expiryDate to start alerting (7–120). */
  licenseExpiryDays: number;
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  inactivityAlert: false,
  inactivityThresholdMin: 20,
  shiftRemindersEnabled: true,
  licenseExpiryAlert: true,
  licenseExpiryDays: 30,
};

const clamp = (v: any, min: number, max: number, fallback: number) => {
  // A CLEARED field arrives as null / '' — that means "use the default", NOT the
  // range minimum. Number(null)===0 and Number('')===0 are finite, so without
  // this guard a blanked "días antes de vencimiento" saved as 7 (min) instead of
  // the intended default 30.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Sanitize a client-supplied guardSettings payload to known keys/ranges. */
export function resolveGuardSettings(raw: any): GuardSettings {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    inactivityAlert: !!src.inactivityAlert,
    inactivityThresholdMin: clamp(src.inactivityThresholdMin, 10, 120, DEFAULT_GUARD_SETTINGS.inactivityThresholdMin),
    shiftRemindersEnabled: src.shiftRemindersEnabled !== false,
    licenseExpiryAlert: src.licenseExpiryAlert !== false,
    licenseExpiryDays: clamp(src.licenseExpiryDays, 7, 120, DEFAULT_GUARD_SETTINGS.licenseExpiryDays),
  };
}

/** Read a tenant's guard settings with defaults merged. Never throws. */
export async function getGuardSettings(db: any, tenantId: string): Promise<GuardSettings> {
  try {
    if (!db?.settings || !tenantId) return { ...DEFAULT_GUARD_SETTINGS };
    const row = await db.settings.findOne({
      where: { tenantId },
      attributes: ['guardSettings'],
    });
    return resolveGuardSettings(row ? (row as any).guardSettings : null);
  } catch {
    return { ...DEFAULT_GUARD_SETTINGS };
  }
}

export default { getGuardSettings, resolveGuardSettings, DEFAULT_GUARD_SETTINGS };
