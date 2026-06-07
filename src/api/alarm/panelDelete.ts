import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// DELETE /tenant/:tenantId/alarm/panel/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) throw new Error404(req.language);

    await record.destroy(); // paranoid: soft delete
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
