import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';

// GET /tenant/:tenantId/security-guard/:id/on-duty
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const targetId = req.params.id;
    const guard = await SecurityGuardRepository.findById(targetId, req);
    if (!guard) {
      return ApiResponseHandler.error(req, res, {
        message: 'Guardia no encontrado',
        code: 404,
      });
    }
    await ApiResponseHandler.success(req, res, { isOnDuty: guard.isOnDuty });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
