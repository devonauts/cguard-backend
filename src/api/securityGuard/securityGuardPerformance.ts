/**
 * @openapi {
 *  "summary": "Guard performance",
 *  "description": "Performance score + breakdown for a specific guard (supervisor view).",
 *  "responses": { "200": { "description": "Performance payload" } }
 * }
 *
 * GET /api/tenant/:tenantId/security-guard/:id/performance?period=30
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardPerformanceService from '../../services/guardPerformanceService';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const periodDays = Math.min(
      180,
      Math.max(7, Number(req.query.period) || 30),
    );

    const payload = await new GuardPerformanceService(req).forSecurityGuard(
      req.params.id,
      periodDays,
    );

    return ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
