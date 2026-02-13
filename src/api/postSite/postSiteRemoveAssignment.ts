import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;
    const assignmentId = req.params.assignmentId;

    if (!assignmentId) {
      throw new Error('assignmentId required');
    }

    // Ensure the row belongs to the given post site
    const sql = `DELETE FROM tenant_user_post_sites WHERE id = :assignmentId AND businessInfoId = :postSiteId`;
    await req.database.sequelize.query(sql, { replacements: { assignmentId, postSiteId } });

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
