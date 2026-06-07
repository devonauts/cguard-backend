import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/video/clip/:id/incident
// Create an incident from a clip, link clip.incidentId.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const clip = await db.videoClip.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!clip) throw new Error404();

    // Best-effort: inherit station/post from the clip's camera.
    let stationId = body.stationId || null;
    let postSiteId = body.postSiteId || null;
    if ((!stationId || !postSiteId) && clip.videoCameraId) {
      const camera = await db.videoCamera
        .findOne({ where: { id: clip.videoCameraId, tenantId } })
        .catch(() => null);
      if (camera) {
        stationId = stationId || camera.stationId || null;
        postSiteId = postSiteId || camera.postSiteId || null;
      }
    }

    const title = body.title || clip.label || 'Incidente desde clip de video';
    const description = body.description || clip.label || null;
    const priority = body.priority || 'medium';
    const now = new Date();

    const incident = await db.incident.create({
      title,
      subject: body.subject || title,
      content: description,
      description,
      priority,
      status: body.status || 'abierto',
      location: body.location || null,
      date: now,
      incidentAt: now,
      dateTime: now,
      stationId,
      postSiteId,
      tenantId,
      createdById: currentUser && currentUser.id,
      updatedById: currentUser && currentUser.id,
    });

    await clip.update({ incidentId: incident.id });

    const plain =
      typeof incident.get === 'function' ? incident.get({ plain: true }) : incident;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
