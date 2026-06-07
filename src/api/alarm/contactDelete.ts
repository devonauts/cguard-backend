import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// DELETE /tenant/:tenantId/alarm/contact/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const contact = await db.alarmContact.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!contact) throw new Error404();

    await contact.destroy();

    await ApiResponseHandler.success(req, res, { id: req.params.id });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
