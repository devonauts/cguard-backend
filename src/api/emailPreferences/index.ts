import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { EMAIL_CATALOG } from '../../lib/emailCatalog';
import { getEmailPreferences } from '../../lib/emailPrefs';

/**
 * Tenant email preferences — one on/off switch per email the platform sends
 * (see src/lib/emailCatalog.ts). Stored as a JSON map on the per-tenant
 * `settings` row. We touch ONLY the preferences column so we never disturb the
 * tenant logo/theme.
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

export default (app) => {
  // GET catalog + current values.
  app.get('/tenant/:tenantId/email-preferences', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;

      const preferences = await getEmailPreferences(db, tenantId);
      return ApiResponseHandler.success(req, res, {
        catalog: EMAIL_CATALOG,
        preferences,
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT — merge the provided on/off map (known, non-locked keys only).
  app.put('/tenant/:tenantId/email-preferences', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const body = req.body.data || req.body || {};
      const incoming = body.preferences || body || {};

      const record = await ensureSettings(db, tenantId, req.currentUser);
      const current = (record.emailPreferences && typeof record.emailPreferences === 'object')
        ? { ...record.emailPreferences }
        : {};

      for (const item of EMAIL_CATALOG) {
        if (item.locked) continue; // never store/allow disabling locked emails
        if (typeof incoming[item.key] === 'boolean') {
          current[item.key] = incoming[item.key];
        }
      }

      record.emailPreferences = current;
      await record.update({
        emailPreferences: current,
        updatedById: req.currentUser && req.currentUser.id,
      });

      const preferences = await getEmailPreferences(db, tenantId);
      return ApiResponseHandler.success(req, res, {
        catalog: EMAIL_CATALOG,
        preferences,
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
