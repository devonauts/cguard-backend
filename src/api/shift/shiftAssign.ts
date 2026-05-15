import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftService from '../../services/shiftService';

/**
 * PATCH /tenant/:tenantId/shift/:id/assign
 * Body: { data: { guard: "<userId>" } }
 *
 * Assigns a security guard to an open (unassigned) shift.
 * Reuses the existing ShiftService.update path so all pivot-table
 * synchronisation logic (tenant_user_post_sites) runs automatically.
 */
export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.shiftEdit);

    const { guard } = req.body?.data ?? {};

    if (!guard) {
      return res.status(400).json({ message: 'guard id is required' });
    }

    // Load current shift to preserve existing fields
    const current = await new ShiftService(req).findById(req.params.id);

    const payload = await new ShiftService(req).update(req.params.id, {
      startTime: current.startTime,
      endTime: current.endTime,
      guard,
      station: current.stationId,
      postSite: current.postSiteId,
    });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
