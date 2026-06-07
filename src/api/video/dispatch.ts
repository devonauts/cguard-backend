import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// POST /tenant/:tenantId/video/dispatch
// Body: { cameraId|eventId, note }
// Records a high-severity manual videoEvent ('Despacho solicitado') and best-effort
// pushes a notification to the tenant's supervisors.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const cameraId = body.cameraId || body.videoCameraId || null;
    const note = body.note || null;

    // Resolve station/post + device from the camera (or source event) so the
    // dispatch event is attributed to the right place.
    let videoCameraId = cameraId;
    let videoDeviceId = body.videoDeviceId || null;
    let stationId = body.stationId || null;
    let postSiteId = body.postSiteId || null;

    if (body.eventId) {
      const srcEvent = await db.videoEvent
        .findOne({ where: { id: body.eventId, tenantId } })
        .catch(() => null);
      if (srcEvent) {
        videoCameraId = videoCameraId || srcEvent.videoCameraId;
        videoDeviceId = videoDeviceId || srcEvent.videoDeviceId;
        stationId = stationId || srcEvent.stationId;
        postSiteId = postSiteId || srcEvent.postSiteId;
      }
    }

    if (videoCameraId && (!videoDeviceId || !stationId || !postSiteId)) {
      const camera = await db.videoCamera
        .findOne({ where: { id: videoCameraId, tenantId } })
        .catch(() => null);
      if (camera) {
        videoDeviceId = videoDeviceId || camera.videoDeviceId;
        stationId = stationId || camera.stationId;
        postSiteId = postSiteId || camera.postSiteId;
      }
    }

    const title = 'Despacho solicitado';
    const description = note;

    await db.videoEvent.create({
      videoCameraId: videoCameraId || null,
      videoDeviceId: videoDeviceId || null,
      type: 'manual',
      severity: 'high',
      at: new Date(),
      title,
      description,
      status: 'new',
      stationId: stationId || null,
      postSiteId: postSiteId || null,
      tenantId,
      createdById: currentUser && currentUser.id,
    });

    // Best-effort push to the tenant's supervisors — never blocks the dispatch.
    try {
      const { pushToTenant } = require('../../services/pushService');
      await pushToTenant(db, tenantId, {
        title,
        body: note || 'Se solicitó un despacho de supervisor.',
        data: {
          type: 'video.dispatch',
          cameraId: videoCameraId || '',
          eventId: body.eventId || '',
        },
      });
    } catch (e: any) {
      console.warn('[videoDispatch] push failed', e?.message || e);
    }

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
