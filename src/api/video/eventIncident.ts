import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/video/event/:id/incident
// Create an incident linked to the video event, set event.incidentId.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const event = await db.videoEvent.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!event) throw new Error404();

    const title =
      body.title || event.title || 'Incidente desde evento de video';
    const description =
      body.description || event.description || null;
    const priority = body.priority || 'medium';
    const stationId = body.stationId || event.stationId || null;
    const postSiteId = body.postSiteId || event.postSiteId || null;
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

    await event.update({ incidentId: incident.id });

    const plain =
      typeof incident.get === 'function' ? incident.get({ plain: true }) : incident;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
