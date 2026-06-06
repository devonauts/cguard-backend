/**
 * GET /api/tenant/:tenantId/security-guard/:id/uniform-inspections
 * Uniform-inspection history for a guard (resolved to their user id).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import UniformInspectionService from '../../services/uniformInspectionService';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.uniformInspectionRead,
    );
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const sg = await db.securityGuard.findOne({
      where: { id: req.params.id, tenantId, deletedAt: null },
      attributes: ['guardId'],
    });
    if (!sg?.guardId) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }

    const rows = await UniformInspectionService.listForSubject(
      db,
      tenantId,
      sg.guardId,
    );
    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
