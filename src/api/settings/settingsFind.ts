import ApiResponseHandler from '../apiResponseHandler';
import SettingsService from '../../services/settingsService';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    // Staff read via settingsRead; the customer app (separate repo, deployed)
    // also reads this blob for branding, so the customer role passes too.
    const checker = new PermissionChecker(req);
    const isCustomer = ((checker.currentUserRolesIds || []) as string[]).includes(
      Roles.values.customer,
    );
    if (!isCustomer && !checker.has(Permissions.values.settingsRead)) {
      throw new Error403();
    }

    const payload = await SettingsService.findOrCreateDefault(
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
