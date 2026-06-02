/**
 * POST /api/tenant/:tenantId/guard/me/incident
 *
 * Lets an on-duty guard report an incident (incl. panic alerts) about their
 * own post WITHOUT the admin `incidentCreate` permission. The incident is
 * attributed to the guard + their station.
 *
 * Body: { subject|title, content|description, priority, location, stationId?,
 *         postSiteId?, incidentTypeId?, incidentAt?, idPhoto? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import FileRepository from '../../database/repositories/fileRepository';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const data = req.body.data || req.body || {};
    const title = data.title || data.subject;
    if (!title) throw new Error400(req.language, 'incident.titleRequired');

    // Resolve the guard + a default station/post.
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });

    let stationId = data.stationId || null;
    let postSiteId = data.postSiteId || null;
    if (!stationId) {
      const station = await db.station
        .findOne({
          where: { tenantId, deletedAt: null },
          include: [
            {
              model: db.user,
              as: 'assignedGuards',
              where: { id: userId },
              attributes: ['id'],
              through: { attributes: [] },
              required: true,
            },
          ],
          attributes: ['id', 'postSiteId'],
        })
        .catch(() => null);
      if (station) {
        stationId = station.id;
        postSiteId = postSiteId || station.postSiteId;
      }
    }

    const incident = await db.incident.create({
      title,
      subject: data.subject || title,
      content: data.content || data.description || null,
      description: data.description || data.content || null,
      priority: data.priority || 'medium',
      status: data.status || 'abierto',
      location: data.location || null,
      incidentAt: data.incidentAt || new Date(),
      dateTime: data.incidentAt || new Date(),
      incidentTypeId: data.incidentTypeId || null,
      stationId,
      postSiteId,
      guardNameId: securityGuard ? securityGuard.id : null,
      callerName: securityGuard ? securityGuard.fullName : null,
      callerType: 'guard',
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    // Optional photo evidence (same file-relation pattern as visitor idPhoto).
    if (Array.isArray(data.idPhoto) && data.idPhoto.length) {
      try {
        await FileRepository.replaceRelationFiles(
          {
            belongsTo: 'incident',
            belongsToColumn: 'imageUrl',
            belongsToId: incident.id,
          },
          data.idPhoto,
          { database: db, currentUser, currentTenant: { id: tenantId } } as any,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('guard incident photo link failed', msg);
      }
    }

    return ApiResponseHandler.success(req, res, incident.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
