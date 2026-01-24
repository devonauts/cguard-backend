import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentTypeService from '../../services/incidentTypeService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.incidentTypeEdit,
    );

    const service = new IncidentTypeService(req);

    const record = await service.findById(req.params.id);

    const payload = await service.update(req.params.id, {
      active: !record.active,
    });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
