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

    // Lean list: explicit columns, and DROP the `camera` include — the events
    // page resolves camera names from a separate cameras() fetch keyed by
    // videoCameraId, so the joined camera object was never read.
    const rows = await db.videoEvent.findAll({
      where,
      attributes: [
        'id',
        'videoCameraId',
        'videoDeviceId',
        'type',
        'severity',
        'at',
        'title',
        'description',
        'status',
        'acknowledgedById',
        'incidentId',
        'videoClipId',
        'stationId',
        'postSiteId',
        'tenantId',
        'createdById',
        'createdAt',
        'updatedAt',
      ],
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
