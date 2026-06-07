/**
 * POST /tenant/:tenantId/alarm/case/:id/incident
 * Body: { title?, subject?, description?/content?, priority?, location?,
 *         stationId?, postSiteId?, incidentTypeId? }
 *
 * Escalate an alarm case into an operations incident, linking case.incidentId.
 * Station/post are inherited from the case (then its panel) when not supplied.
 * Writes an audit log row. Tenant-scoped; requires businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);

    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const actorId = currentUser && currentUser.id;

    const body = req.body || {};

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!alarmCase) throw new Error404();

    // Inherit station/post from the case, then from its panel.
    let stationId = body.stationId || alarmCase.stationId || null;
    let postSiteId = body.postSiteId || alarmCase.postSiteId || null;
    if ((!stationId || !postSiteId) && alarmCase.alarmPanelId) {
      const panel = await db.alarmPanel
        .findOne({ where: { id: alarmCase.alarmPanelId, tenantId } })
        .catch(() => null);
      if (panel) {
        stationId = stationId || panel.stationId || null;
        postSiteId = postSiteId || panel.postSiteId || null;
      }
    }

    const title =
      body.title ||
      alarmCase.title ||
      `Incidente de alarma${alarmCase.category ? ` (${alarmCase.category})` : ''}`;
    const description = body.description || body.content || alarmCase.title || null;
    // Map alarm priority (1=critical..5=info) to an incident priority label.
    const priority =
      body.priority ||
      (alarmCase.priority != null && alarmCase.priority <= 2 ? 'critical' : 'high');
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
      incidentTypeId: body.incidentTypeId || null,
      stationId,
      postSiteId,
      tenantId,
      createdById: actorId || null,
      updatedById: actorId || null,
    });

    await alarmCase.update({
      incidentId: incident.id,
      updatedById: actorId || null,
    });

    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'incident',
      detail: `Incidente creado (${incident.id})`,
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    const plain =
      typeof incident.get === 'function' ? incident.get({ plain: true }) : incident;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
