/**
 * Notification channel preferences (Panel de control / Correo / SMS) per
 * notification type, as configured on the Configuración → Notificaciones page.
 *
 * Preferences are stored as JSON on the tenant's settings row:
 *   { [rowId]: { dashboard: boolean, email: boolean, sms: boolean } }
 * keyed by the row ids used by the frontend NotificationForm.
 *
 * EVENT_TO_ROW maps a dispatcher eventType to the row whose switches govern it.
 * Defaults (when a row has no saved prefs): dashboard ON, email OFF, sms OFF.
 */

export interface ChannelPrefs {
  dashboard: boolean;
  email: boolean;
  sms: boolean;
}

export const DEFAULT_CHANNELS: ChannelPrefs = {
  dashboard: true,
  email: false,
  sms: false,
};

/**
 * Per-row default overrides, applied when a tenant has not explicitly saved a
 * channel for that row. Clock-in/out emails are ON by default (the client and
 * tenant want to know the moment a guard starts a shift); a tenant can still
 * turn them off in Configuración → Notificaciones.
 */
export const ROW_DEFAULTS: Record<string, Partial<ChannelPrefs>> = {
  'check-in-out': { email: true },
};

/** dispatcher eventType → Notificaciones row id (frontend NotificationForm ids). */
export const EVENT_TO_ROW: Record<string, string> = {
  'guard.checkin': 'check-in-out',
  'guard.checkout': 'check-in-out',
  'task.completed': 'task-completed',
  'task.overdue': 'task-missed',
  'patrol.completed': 'site-tour-complete',
  'patrol.missed': 'site-tour-missed',
  'incident.created': 'dispatch-updates',
  'incident.updated': 'dispatch-updates',
  'dispatch.created': 'dispatch-updates',
  'shift.unassigned': 'shift-status',
  'shift.exchange_approved': 'shift-status',
  'shift.exchange_rejected': 'shift-status',
  'shift.exchange_requested': 'shift-status',
  'guard.late': 'late-on-shift',
  'timeoff.requested': 'pto-request',
  'timeoff.approved': 'pto-request',
  'timeoff.rejected': 'pto-request',
};

/** Read the tenant's full notification-channel preference map. */
export async function getNotificationPreferences(
  db: any,
  tenantId: string,
): Promise<Record<string, Partial<ChannelPrefs>>> {
  try {
    if (!db || !tenantId) return {};
    const settings = await db.settings.findByPk(tenantId);
    const raw = settings && settings.notificationPreferences;
    if (!raw) return {};
    return typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Effective channel prefs for a single eventType (merged over defaults). */
export async function channelsForEvent(
  db: any,
  tenantId: string,
  eventType: string,
): Promise<{ rowId: string | null; prefs: ChannelPrefs }> {
  const rowId = EVENT_TO_ROW[eventType] || null;
  if (!rowId) return { rowId: null, prefs: { ...DEFAULT_CHANNELS } };
  const all = await getNotificationPreferences(db, tenantId);
  const saved = all[rowId] || {};
  const rowDefault = ROW_DEFAULTS[rowId] || {};
  const def = (k: keyof ChannelPrefs) =>
    typeof rowDefault[k] === 'boolean' ? (rowDefault[k] as boolean) : DEFAULT_CHANNELS[k];
  return {
    rowId,
    prefs: {
      dashboard: typeof saved.dashboard === 'boolean' ? saved.dashboard : def('dashboard'),
      email: typeof saved.email === 'boolean' ? saved.email : def('email'),
      sms: typeof saved.sms === 'boolean' ? saved.sms : def('sms'),
    },
  };
}
