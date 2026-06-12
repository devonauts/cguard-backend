import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import UserRepository from '../../database/repositories/userRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userEdit,
    );

    const id = req.params.id;
    const incoming = req.body && req.body.data ? req.body.data : req.body;

    const payload = await UserRepository.patchUpdate(id, incoming || {}, req);

    // Per-user permission overrides (admin-only). Requires settingsEdit in
    // addition to userEdit; the repository enforces the admin-floor lockout guard.
    if (incoming && incoming.permissionOverrides) {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      await TenantUserRepository.updatePermissionOverrides(
        req.currentTenant && req.currentTenant.id,
        id,
        incoming.permissionOverrides,
        req,
      );
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
