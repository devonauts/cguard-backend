import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardLicenseService from '../../services/guardLicenseService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardEdit,
    );

    const guardId = req.params.id;
    const data = req.body || {};
    data.guardId = guardId;

    const created = await new GuardLicenseService(req).create(data);

    const messageCode = 'guards.licenseCreated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
