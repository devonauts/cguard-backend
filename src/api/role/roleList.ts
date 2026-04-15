import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import RoleService from '../../services/roleService';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.settingsRead,
    );

    let payload = await new RoleService(req).findAndCountAll(req.query || {});

    const noFilter = !req.query || !req.query.filter;
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.rows)
      ? payload.rows
      : [];

    const hasSupervisorRole = rows.some((role) => {
      const id = String(role?.id ?? role?.slug ?? role?.name ?? '').toLowerCase();
      return id === 'securitysupervisor' || id.includes('supervisor');
    });

    if (noFilter && !hasSupervisorRole) {
      const supervisorRole = {
        id: Roles.values.securitySupervisor,
        name: Roles.values.securitySupervisor,
        slug: Roles.values.securitySupervisor,
        description: Roles.descriptions.securitySupervisor,
      };

      if (Array.isArray(payload)) {
        payload = { rows: [...payload, supervisorRole], count: payload.length + 1 };
      } else {
        payload.rows = [...rows, supervisorRole];
        payload.count = (payload.count || rows.length) + 1;
      }
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
