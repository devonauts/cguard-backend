import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// GET /tenant/:tenantId/video/device/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.videoDevice.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.password;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
