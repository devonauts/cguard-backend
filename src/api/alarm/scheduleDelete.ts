import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// DELETE /tenant/:tenantId/alarm/schedule/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const schedule = await db.openCloseSchedule.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!schedule) throw new Error404();

    await schedule.destroy();

    await ApiResponseHandler.success(req, res, { id: req.params.id });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
