/**
 * Client-app notification preferences API (Mi Seguridad). FEATURE #23.
 * Auth = the customer JWT (currentUser.clientAccountId). The client mutes/unmutes
 * CATEGORIES of push notifications; clientNotifyService respects these before
 * sending a customer push.
 *
 *   GET  /customer/notification-preferences
 *        → { preferences: [{ category, enabled }] }  (all known categories, with
 *           their effective value — default true when unset)
 *   PUT  /customer/notification-preferences
 *        body { preferences: [{ category, enabled }] }  OR  { category, enabled }
 *        → upsert; returns the full effective list (same shape as GET).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import { NOTIFICATION_CATEGORIES, isKnownCategory } from '../../services/notificationCategories';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/** Build the full effective list: every known category + its stored value (default true). */
async function effectivePreferences(db: any, clientAccountId: string) {
  const rows = await db.notificationPreference.findAll({
    where: { clientAccountId, deletedAt: null },
    attributes: ['category', 'enabled'],
  });
  const byCategory = new Map<string, boolean>();
  for (const r of rows || []) byCategory.set(String(r.category), r.enabled !== false);
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    enabled: byCategory.has(category) ? (byCategory.get(category) as boolean) : true,
  }));
}

export const customerNotificationPreferencesList = async (req, res) => {
  try {
    const { db, clientAccountId } = customerCtx(req);
    const preferences = await effectivePreferences(db, clientAccountId);
    await ApiResponseHandler.success(req, res, { preferences });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const customerNotificationPreferencesUpdate = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};

    // Accept either a list { preferences: [...] } or a single { category, enabled }.
    let incoming: Array<{ category: any; enabled: any }> = [];
    if (Array.isArray(b.preferences)) {
      incoming = b.preferences;
    } else if (b.category !== undefined) {
      incoming = [{ category: b.category, enabled: b.enabled }];
    }

    // Normalise + validate: keep only known categories, coerce enabled to boolean.
    const updates = new Map<string, boolean>();
    for (const p of incoming) {
      const category = String((p && p.category) || '').trim();
      if (!isKnownCategory(category)) continue;
      // Default to true when enabled is omitted/non-boolean-ish; treat false/0/'false' as muted.
      const raw = p ? p.enabled : undefined;
      const enabled = !(raw === false || raw === 0 || raw === '0' || raw === 'false');
      updates.set(category, enabled);
    }

    if (!updates.size) {
      return ApiResponseHandler.error(req, res, new Error('No hay categorías válidas para actualizar'));
    }

    for (const [category, enabled] of updates) {
      const existing = await db.notificationPreference.findOne({
        where: { clientAccountId, category, deletedAt: null },
      });
      if (existing) {
        await existing.update({ enabled, userId, updatedById: userId });
      } else {
        await db.notificationPreference.create({
          clientAccountId,
          userId,
          category,
          enabled,
          tenantId,
          createdById: userId,
          updatedById: userId,
        });
      }
    }

    const preferences = await effectivePreferences(db, clientAccountId);
    await ApiResponseHandler.success(req, res, { preferences });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
