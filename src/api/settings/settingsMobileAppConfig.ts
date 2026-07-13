/** @openapi { "summary": "Mobile app config (worker/supervisor branding + modules)", "responses": { "200": { "description": "Resolved mobile-app customization for this tenant" } } } */

/**
 * GET /tenant/:tenantId/mobile-app-config
 *
 * App-facing read of the Team-mobile-hub customization: resolved (defaults
 * merged + sanitized) mobileAppSettings plus the tenant's logo URL and name.
 * Auth + tenant membership only — every guard/supervisor needs it at launch,
 * so no settingsRead permission is required (it's branding, not sensitive).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import {
  resolveMobileAppSettings,
} from '../../services/mobileAppSettingsService';
import { resolvePostRules } from '../../services/postRulesService';

export default async (req, res) => {
  try {
    if (!req.currentUser) throw new Error401();
    const tenant = req.currentTenant;
    if (!tenant) throw new Error401();

    const row = await req.database.settings.findOne({
      where: { tenantId: tenant.id },
    });

    const resolved = resolveMobileAppSettings(row ? (row as any).mobileAppSettings : null);
    const postRules = resolvePostRules(row ? (row as any).postRules : null);

    await ApiResponseHandler.success(req, res, {
      ...resolved,
      // Reglas de puestos the apps need for proactive UX (server re-enforces).
      postRules,
      tenantName: tenant.name || null,
      // Canonical tenant logo (same source EmailSender uses).
      logoUrl: (row && (row as any).logoUrl) || null,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
