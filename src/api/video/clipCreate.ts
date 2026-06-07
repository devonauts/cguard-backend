import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

// POST /tenant/:tenantId/video/clip  (trim)
// Body: { videoCameraId, startAt, endAt, label }
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    if (!body.videoCameraId) {
      throw new Error400(req.language, 'errors.validation.missingFields');
    }

    const camera = await db.videoCamera.findOne({
      where: { id: body.videoCameraId, tenantId },
    });

    const startAt = body.startAt ? new Date(body.startAt) : null;
    const endAt = body.endAt ? new Date(body.endAt) : null;
    let durationSec: number | null = null;
    if (startAt && endAt) {
      durationSec = Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 1000));
    }

    // A clip is "ready" only when the source camera has a playback/stream url to
    // trim from; otherwise the media gateway still needs to produce it.
    const cameraUrl = camera
      ? camera.streamUrl || camera.rtspUrl || null
      : null;

    const payload: any = {
      videoCameraId: body.videoCameraId,
      videoDeviceId: body.videoDeviceId || (camera ? camera.videoDeviceId : null),
      startAt,
      endAt,
      durationSec,
      url: body.url || null,
      thumbnailUrl: body.thumbnailUrl || (camera ? camera.snapshotUrl : null) || null,
      label: body.label || null,
      status: cameraUrl ? 'ready' : 'pending',
      tenantId,
      createdById: currentUser && currentUser.id,
    };

    const record = await db.videoClip.create(payload);
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
