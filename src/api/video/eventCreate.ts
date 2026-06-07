import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// POST /tenant/:tenantId/video/event  (manual event)
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const payload: any = {
      videoCameraId: body.videoCameraId || null,
      videoDeviceId: body.videoDeviceId || null,
      type: body.type || 'manual',
      severity: body.severity || 'medium',
      at: body.at ? new Date(body.at) : new Date(),
      title: body.title || null,
      description: body.description || null,
      status: body.status || 'new',
      videoClipId: body.videoClipId || null,
      stationId: body.stationId || null,
      postSiteId: body.postSiteId || null,
      tenantId,
      createdById: currentUser && currentUser.id,
    };

    const record = await db.videoEvent.create(payload);
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
