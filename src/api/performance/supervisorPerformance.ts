/**
 * GET /api/tenant/:tenantId/supervisor/:id/performance?period=30
 * Performance score + breakdown for a supervisor (a staff user id). Guard-only
 * factors drop and the remaining weights renormalize.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardPerformanceService from '../../services/guardPerformanceService';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const periodDays = Math.min(
      180,
      Math.max(7, Number(req.query.period) || 30),
    );

    const payload = await new GuardPerformanceService(req).forSupervisor(
      req.params.id,
      periodDays,
    );

    return ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
