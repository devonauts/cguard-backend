import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// GET /tenant/:tenantId/video/clips?cameraId=
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const where: any = { tenantId };
    if (req.query && req.query.cameraId) where.videoCameraId = req.query.cameraId;
    if (req.query && req.query.deviceId) where.videoDeviceId = req.query.deviceId;
    if (req.query && req.query.status) where.status = req.query.status;

    // Lean list: explicit columns, drop the unused `camera` include, and never
    // ship the share secret (shareToken/shareExpiresAt) in a list payload — the
    // public viewer route looks clips up by token directly. Cap the result set.
    const rawLimit = parseInt(String((req.query || {}).limit), 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    const rows = await db.videoClip.findAll({
      where,
      attributes: [
        'id',
        'videoCameraId',
        'videoDeviceId',
        'startAt',
        'endAt',
        'durationSec',
        'url',
        'thumbnailUrl',
        'label',
        'status',
        'incidentId',
        'alarmCaseId',
        'createdById',
        'tenantId',
        'createdAt',
        'updatedAt',
      ],
      order: [['createdAt', 'DESC']],
      limit,
    });

    const out = (rows || []).map((r: any) =>
      typeof r.get === 'function' ? r.get({ plain: true }) : r,
    );

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
