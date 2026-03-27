import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftService from '../../services/shiftService';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;
    const assignmentId = req.params.assignmentId;

    if (!assignmentId) {
      throw new Error('assignmentId required');
    }

    // Prefer deleting a Shift record (canonical source). If not found, fall back to deleting the pivot row.
    try {
      const shiftService = new ShiftService({ currentTenant: req.currentTenant, language: req.language, database: req.database, currentUser: req.currentUser });
      await shiftService.destroyAll([assignmentId]);
      console.debug('[postSiteRemoveAssignment] deleted shift', assignmentId);
    } catch (err) {
      console.warn('[postSiteRemoveAssignment] failed to delete shift, falling back to pivot delete', (err as any)?.message || err);
      // Ensure the row belongs to the given post site when deleting pivot
      const sql = `DELETE FROM tenant_user_post_sites WHERE id = :assignmentId AND businessInfoId = :postSiteId`;
      await req.database.sequelize.query(sql, { replacements: { assignmentId, postSiteId } });
      console.debug('[postSiteRemoveAssignment] deleted pivot row', assignmentId);
    }

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
