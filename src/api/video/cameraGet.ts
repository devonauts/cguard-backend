/**
 * GET /tenant/:tenantId/video/camera/:id
 *
 * Fetch a single video camera (with its device) for the current tenant.
 * Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const camera = await db.videoCamera.findOne({
      where: { id: req.params.id, tenantId },
      include: [{ model: db.videoDevice, as: 'device', required: false }],
    });

    if (!camera) throw new Error404();

    await ApiResponseHandler.success(req, res, camera);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
