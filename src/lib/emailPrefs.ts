/**
 * Per-tenant email on/off enforcement. Reads the JSON `emailPreferences` map
 * off the tenant's settings row and answers "should we send <key>?".
 *
 * Fail-open: if anything goes wrong reading the preference, we send (preserves
 * historical behaviour and never silently swallows a critical email).
 */
import { EMAIL_CATALOG, defaultPreferences, isLocked } from './emailCatalog';

export async function getEmailPreferences(
  db: any,
  tenantId: string,
): Promise<Record<string, boolean>> {
  const defaults = defaultPreferences();
  try {
    if (!db || !tenantId) return defaults;
    const settings = await db.settings.findByPk(tenantId);
    const stored = (settings && settings.emailPreferences) || {};
    // Only keep known keys; locked keys are always on.
    const merged = { ...defaults };
    for (const item of EMAIL_CATALOG) {
      if (item.locked) {
        merged[item.key] = true;
      } else if (typeof stored[item.key] === 'boolean') {
        merged[item.key] = stored[item.key];
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

export async function isEmailEnabled(
  db: any,
  tenantId: string,
  key: string,
): Promise<boolean> {
  if (isLocked(key)) return true;
  try {
    const prefs = await getEmailPreferences(db, tenantId);
    return prefs[key] !== false;
  } catch {
    return true;
  }
}
