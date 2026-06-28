/**
 * Notification categories for the Mi Seguridad customer app + the mapping from the
 * push `data.type` values the backend actually sends to one of these categories.
 *
 * FEATURE #23: the client can mute/unmute a CATEGORY; clientNotifyService checks
 * the clientAccount's notificationPreference for the derived category before
 * sending and SKIPS muted categories (fail-open: unset/unknown → send).
 *
 * The category list mirrors the customer-facing `data.type` / eventType values
 * grepped from clientNotifyService + the customer push endpoints:
 *   incidents  ← incident.created, incident_reported, incident_escalated, escalation
 *   messages   ← message.new
 *   coverage   ← coverage, guard.checkin, guard.checkout, guard.shiftchange,
 *                guard.forced_clockout
 *   visitors   ← visitor.registered, visitor.arrival, visitor_removal
 *   patrols    ← patrol.started, patrol.completed, patrol.missed
 *   support    ← request.created, task.approved/rejected/completed, guard.rated
 *   documents  ← document.* (reserved — shared docs / files pushes)
 *   digest     ← digest.* (reserved — periodic summary pushes)
 *   sos        ← sos
 */

export const NOTIFICATION_CATEGORIES = [
  'incidents',
  'messages',
  'coverage',
  'visitors',
  'patrols',
  'support',
  'documents',
  'digest',
  'sos',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(NOTIFICATION_CATEGORIES as readonly string[]);

/** True when `category` is a recognised customer notification category. */
export function isKnownCategory(category?: string | null): boolean {
  return !!category && CATEGORY_SET.has(category);
}

/**
 * Map a push `data.type` / eventType to its mute-able category. Matches both the
 * exact strings used and dotted prefixes (e.g. `incident.created`, `task.*`).
 * Returns null when the type isn't customer-facing / mute-able (treated as
 * always-send).
 */
export function categoryForType(type?: string | null): NotificationCategory | null {
  if (!type) return null;
  const t = String(type).toLowerCase();

  // Exact / already-a-category (e.g. 'coverage', 'sos').
  if (CATEGORY_SET.has(t)) return t as NotificationCategory;

  if (t === 'sos') return 'sos';

  if (t.startsWith('incident') || t === 'escalation') return 'incidents';
  if (t.startsWith('message')) return 'messages';
  if (t === 'coverage' || t.startsWith('guard.check') || t === 'guard.shiftchange' || t === 'guard.forced_clockout') {
    return 'coverage';
  }
  if (t.startsWith('visitor')) return 'visitors';
  if (t.startsWith('patrol') || t.startsWith('ronda')) return 'patrols';
  if (
    t.startsWith('request') ||
    t.startsWith('task') ||
    t === 'guard.rated' ||
    t.startsWith('support')
  ) {
    return 'support';
  }
  if (t.startsWith('document') || t.startsWith('file')) return 'documents';
  if (t.startsWith('digest')) return 'digest';

  return null;
}

/**
 * Is the given category enabled for this clientAccount? FAIL-OPEN: defaults to
 * true when there is no row, when the category is unknown/unmappable, or when any
 * lookup error occurs. So an absent preference, an unmapped push type, or a DB
 * hiccup all still SEND.
 */
export async function isCategoryEnabled(
  db: any,
  clientAccountId?: string | null,
  category?: string | null,
): Promise<boolean> {
  try {
    if (!db || !db.notificationPreference) return true;
    if (!clientAccountId || !category) return true;
    if (!isKnownCategory(category)) return true;

    const pref = await db.notificationPreference.findOne({
      where: { clientAccountId, category, deletedAt: null },
      attributes: ['enabled'],
    });
    if (!pref) return true; // unset → send
    return pref.enabled !== false; // explicit false → mute; anything else → send
  } catch (e: any) {
    // Fail open — never let a preference lookup block a push.
    console.warn('[notificationCategories] isCategoryEnabled failed (sending):', e?.message || e);
    return true;
  }
}
