/**
 * POST /api/tenant/:tenantId/uniform-inspection
 * body.data = { subjectUserId | securityGuardId, rating(0..100), stars?, notes?, photos?[], stationId?, inspectionDate? }
 * A supervisor records a uniform inspection for a guard/supervisor.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import UniformInspectionService from '../../services/uniformInspectionService';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.uniformInspectionCreate,
    );
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const data = (req.body && req.body.data) || req.body || {};

    // Resolve the subject user id (accept either a user id or a guard id).
    let subjectUserId = data.subjectUserId || null;
    if (!subjectUserId && data.securityGuardId) {
      const sg = await db.securityGuard.findOne({
        where: { id: data.securityGuardId, tenantId, deletedAt: null },
        attributes: ['guardId'],
      });
      subjectUserId = sg?.guardId || null;
    }
    if (!subjectUserId) throw new Error400(req.language, 'uniform.subjectRequired');
    if (data.rating == null) throw new Error400(req.language, 'uniform.ratingRequired');

    const created = await UniformInspectionService.create(db, {
      tenantId,
      subjectUserId,
      inspectorId: req.currentUser.id,
      rating: Number(data.rating),
      stars: data.stars != null ? Number(data.stars) : null,
      notes: data.notes || null,
      photos: Array.isArray(data.photos) ? data.photos : [],
      stationId: data.stationId || null,
      inspectionDate: data.inspectionDate || null,
    });

    return ApiResponseHandler.success(req, res, created);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
