import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// GET /tenant/:tenantId/video/events?status=&cameraId=
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const where: any = { tenantId };
    if (req.query && req.query.status) where.status = req.query.status;
    if (req.query && req.query.cameraId) where.videoCameraId = req.query.cameraId;
    if (req.query && req.query.deviceId) where.videoDeviceId = req.query.deviceId;
    if (req.query && req.query.type) where.type = req.query.type;

    const rows = await db.videoEvent.findAll({
      where,
      include: [{ model: db.videoCamera, as: 'camera', required: false }],
      order: [['at', 'DESC']],
    });

    const out = (rows || []).map((r: any) =>
      typeof r.get === 'function' ? r.get({ plain: true }) : r,
    );

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
