import SettingsService from '../../services/settingsService';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { resolveMobileAppSettings } from '../../services/mobileAppSettingsService';
import { resolvePostRules } from '../../services/postRulesService';
import { resolveGuardSettings } from '../../services/guardSettingsService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.settingsEdit,
    );

    const settings = req.body.settings || {};
    // Team mobile hub: never store unvalidated JSON — clamp/sanitize every
    // field (hex color, text lengths, known enums/booleans) before it hits
    // the row the mobile apps read from.
    if (settings.mobileAppSettings !== undefined) {
      settings.mobileAppSettings = resolveMobileAppSettings(settings.mobileAppSettings);
    }
    // Reglas globales de puestos: same rule — only known boolean keys land.
    if (settings.postRules !== undefined) {
      settings.postRules = resolvePostRules(settings.postRules);
    }
    // Configuración global de vigilantes: clamp to known keys/ranges.
    if (settings.guardSettings !== undefined) {
      settings.guardSettings = resolveGuardSettings(settings.guardSettings);
    }

    const payload = await SettingsService.save(
      settings,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
