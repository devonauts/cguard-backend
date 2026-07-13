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

    // Fallback for tenants whose DB was never seeded with the built-in
    // securitySupervisor role. Detect by slug/name — NOT by id: real DB rows
    // carry UUID ids, so the old id-based check never matched and the
    // synthetic row was appended even when the real one existed (duplicate
    // "Supervisor de Seguridad" in the CRM).
    const hasSupervisorRole = rows.some((role) => {
      const key = String(role?.slug ?? role?.name ?? '').toLowerCase();
      return key === 'securitysupervisor';
    });

    if (noFilter && !hasSupervisorRole) {
      const supervisorRole = {
        id: Roles.values.securitySupervisor,
        name: Roles.values.securitySupervisor,
        slug: Roles.values.securitySupervisor,
        description: Roles.descriptions.securitySupervisor,
        // Built-in: mark as system so the CRM shows "Predeterminado" and
        // doesn't offer deleting a row that doesn't exist in the DB.
        isSystem: true,
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
