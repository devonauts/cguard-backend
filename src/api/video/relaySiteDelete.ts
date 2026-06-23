import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// DELETE /tenant/:tenantId/video/relay-site/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const record = await db.videoRelaySite.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) { const err: any = new Error('Not found'); err.code = 404; throw err; }
    await record.destroy(); // paranoid: soft delete
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
