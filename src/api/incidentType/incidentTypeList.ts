import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentTypeService from '../../services/incidentTypeService';
import { ensureDefaultIncidentTypes } from '../../services/incidentTypeDefaults';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.incidentTypeRead,
    );

    // First-touch seeding: a tenant that never created incident types gets
    // the standard catalog (matches the mobile apps' built-in taxonomy) so
    // dispatch forms and guard reports work out of the box.
    const tenant = req.currentTenant;
    if (tenant?.id) {
      await ensureDefaultIncidentTypes(req.database, tenant.id, req.currentUser?.id);
    }

    const payload = await new IncidentTypeService(req).findAndCountAll(
      req.query,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
