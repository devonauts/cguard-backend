import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { EMAIL_CATALOG } from '../../lib/emailCatalog';
import { getEmailPreferences } from '../../lib/emailPrefs';
import {
  renderNotificationEmail,
  getEmailBranding,
  clearEmailBrandingCache,
  safeHex,
  DEFAULT_BRAND_COLOR,
  DEFAULT_HEADER_COLOR,
} from '../../lib/emailLayout';

/** Normalize a branding blob to the two safe hex colors we persist. */
function normalizeBranding(raw: any): { brandColor: string; headerColor: string } {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    brandColor: safeHex(b.brandColor, DEFAULT_BRAND_COLOR),
    headerColor: safeHex(b.headerColor, DEFAULT_HEADER_COLOR),
  };
}

/**
 * Read branding FRESH from a settings row (no cache) for the UI response — the
 * cached getEmailBranding is per-PM2-instance, so a save on one instance could
 * otherwise read stale on another for up to the TTL. The dispatcher still uses
 * the cache (email volume; a minute of staleness there is fine).
 */
function brandingFromRecord(record: any): { brandColor: string; headerColor: string } {
  let raw: any = record && (record.emailBranding || record.get?.('emailBranding'));
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  return normalizeBranding(raw || {});
}

/** A representative sample email body (guard check-in) for the live preview. */
function sampleBodyHtml(): string {
  return `
    <h2 style="margin:0 0 12px;color:#0A0E16;font-size:20px;">✅ Guardia inició turno</h2>
    <p style="margin:6px 0;"><strong>Guardia:</strong> Juan Pérez</p>
    <p style="margin:6px 0;"><strong>Sitio:</strong> Edificio Central</p>
    <p style="margin:6px 0;"><strong>Puesto:</strong> Garita Principal</p>
    <p style="margin:6px 0;"><strong>Hora de entrada:</strong> 07:58</p>
    <p style="margin:16px 0 4px"><strong>Consignas pendientes</strong></p>
    <ul style="margin:0 0 8px"><li>Verificar cámaras del lobby</li><li>Registrar visitantes en bitácora</li></ul>
  `;
}

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
      const record = await ensureSettings(db, tenantId, req.currentUser);
      return ApiResponseHandler.success(req, res, {
        catalog: EMAIL_CATALOG,
        preferences,
        branding: brandingFromRecord(record),
        logoUrl: (record && (record.logoUrl || record.get?.('logoUrl'))) || null,
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT — merge the provided on/off map (known, non-locked keys only) + branding.
  app.put('/tenant/:tenantId/email-preferences', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const body = req.body.data || req.body || {};
      const incoming = body.preferences || {};

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

      const update: any = {
        emailPreferences: current,
        updatedById: req.currentUser && req.currentUser.id,
      };
      // Branding is optional; only touch it when provided (keeps the endpoint's
      // "never disturb logo/theme" guarantee for callers that only save toggles).
      if (body.branding && typeof body.branding === 'object') {
        update.emailBranding = normalizeBranding(body.branding);
      }
      record.emailPreferences = current;
      await record.update(update);
      clearEmailBrandingCache(tenantId);

      const preferences = await getEmailPreferences(db, tenantId);
      return ApiResponseHandler.success(req, res, {
        catalog: EMAIL_CATALOG,
        preferences,
        branding: brandingFromRecord(record),
        logoUrl: (record && (record.logoUrl || record.get?.('logoUrl'))) || null,
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /email-preferences/preview — render a sample transactional email with
  // DRAFT branding (from the request) + the tenant's real logo, so the CRM shows
  // exactly how emails will look before saving. Returns { html }.
  app.post('/tenant/:tenantId/email-preferences/preview', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const body = req.body.data || req.body || {};

      const saved = await getEmailBranding(db, tenantId);
      const draft = normalizeBranding(body.branding || {});
      // Draft overrides saved so the preview updates live as the user picks colors.
      const brandColor = body.branding ? draft.brandColor : saved.brandColor;
      const headerColor = body.branding ? draft.headerColor : saved.headerColor;

      const html = renderNotificationEmail({
        tenantName: saved.tenantName,
        logoUrl: saved.logoUrl,
        brandColor,
        headerColor,
        eyebrow: 'Notificación',
        title: 'Guardia inició turno',
        body: '',
        bodyHtml: sampleBodyHtml(),
        ctaText: 'Ver en el panel',
        ctaUrl: 'https://app.cguardpro.com',
      });

      return ApiResponseHandler.success(req, res, { html });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
