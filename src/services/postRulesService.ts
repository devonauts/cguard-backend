/**
 * Reglas globales de puestos (Configuración › Configuración Global de Puestos).
 *
 * Stored as JSON in settings.postRules (missing key = default, so new rules
 * ship without migrations). Written from the CRM through the normal settings
 * PUT; enforced server-side:
 *   - requireActiveShiftForRounds → siteTourService.recordTagScan
 *   - geofenceExitAlert/geofenceReturnAlert → guardMeLocation ping pipeline
 */

export interface PostRules {
  /** Block checkpoint/ronda tag scans unless the guard has an open guardShift. */
  requireActiveShiftForRounds: boolean;
  /** Notify (attendance-exceptions channel) when an on-duty guard leaves the
   *  station geofence. Needs 2 consecutive outside pings (GPS-jitter guard). */
  geofenceExitAlert: boolean;
  /** Also notify when the guard comes back inside. */
  geofenceReturnAlert: boolean;
}

export const DEFAULT_POST_RULES: PostRules = {
  requireActiveShiftForRounds: false,
  geofenceExitAlert: false,
  geofenceReturnAlert: false,
};

/** Sanitize a client-supplied postRules payload down to known boolean keys. */
export function resolvePostRules(raw: any): PostRules {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    requireActiveShiftForRounds: !!src.requireActiveShiftForRounds,
    geofenceExitAlert: !!src.geofenceExitAlert,
    geofenceReturnAlert: !!src.geofenceReturnAlert,
  };
}

/** Read the tenant's post rules with defaults merged. Never throws. */
export async function getPostRules(db: any, tenantId: string): Promise<PostRules> {
  try {
    if (!db?.settings || !tenantId) return { ...DEFAULT_POST_RULES };
    const row = await db.settings.findOne({
      where: { tenantId },
      attributes: ['postRules'],
    });
    return resolvePostRules(row ? (row as any).postRules : null);
  } catch {
    return { ...DEFAULT_POST_RULES };
  }
}

export default { getPostRules, resolvePostRules, DEFAULT_POST_RULES };
