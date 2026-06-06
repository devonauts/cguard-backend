import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { getNotificationPreferences } from '../../lib/notificationChannels';

/**
 * Tenant notification-channel preferences (Configuración → Notificaciones):
 *   { [rowId]: { dashboard, email, sms } }
 * Stored as a JSON map on the per-tenant `settings` row. We touch ONLY the
 * notificationPreferences column so logo/theme/email prefs are untouched.
 */

async function ensureSettings(db: any, tenantId: string, currentUser: any) {
  const [record] = await db.settings.findOrCreate({
    where: { id: tenantId, tenantId },
    defaults: {
      id: tenantId,
      tenantId,
      theme: 'default',
      createdById: currentUser ? currentUser.id : null,
    },
  });
  return record;
}

function sanitize(map: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!map || typeof map !== 'object') return out;
  for (const [rowId, channels] of Object.entries(map)) {
    if (!channels || typeof channels !== 'object') continue;
    const c: any = channels;
    out[rowId] = {
      dashboard: !!c.dashboard,
      email: !!c.email,
      sms: !!c.sms,
    };
  }
  return out;
}

export default (app) => {
  app.get('/tenant/:tenantId/notification-preferences', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const preferences = await getNotificationPreferences(db, tenantId);
      return ApiResponseHandler.success(req, res, { preferences });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.put('/tenant/:tenantId/notification-preferences', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const body = req.body.data || req.body || {};
      const incoming = sanitize(body.preferences || body || {});

      const record = await ensureSettings(db, tenantId, req.currentUser);
      record.notificationPreferences = incoming;
      await record.update({
        notificationPreferences: incoming,
        updatedById: req.currentUser && req.currentUser.id,
      });

      const preferences = await getNotificationPreferences(db, tenantId);
      return ApiResponseHandler.success(req, res, { preferences });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
