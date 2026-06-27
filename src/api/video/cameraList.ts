/**
 * GET /tenant/:tenantId/video/cameras?deviceId=&postSiteId=&stationId=
 *
 * List video cameras for the current tenant, optionally filtered by device,
 * post site, or station. Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const { deviceId, postSiteId, stationId } = req.query || {};

    const where: any = { tenantId };
    if (deviceId) where.videoDeviceId = deviceId;
    if (postSiteId) where.postSiteId = postSiteId;
    if (stationId) where.stationId = stationId;

    const cameras = await db.videoCamera.findAll({
      where,
      // Never ship the device credential in a list payload (even encrypted).
      include: [{ model: db.videoDevice, as: 'device', required: false, attributes: { exclude: ['password'] } }],
      order: [['channel', 'ASC']],
    });

    await ApiResponseHandler.success(req, res, cameras);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
