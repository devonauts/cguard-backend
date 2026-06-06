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
import { dispatch } from '../../lib/notificationDispatcher';

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
      // `date` is NOT NULL on the incident model.
      date: data.incidentAt ? new Date(data.incidentAt) : new Date(),
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

    // Push a real-time event to the dashboard. A panic (explicit flag or a
    // 'critical' priority) fires the dedicated `panic.alert` so the admin gets a
    // full-screen red alarm with everything needed to call the police / dispatch
    // a supervisor; everything else is a normal `incident.created`. Best-effort —
    // never blocks the guard's report.
    try {
      const isPanic =
        data.isPanic === true ||
        String(data.priority || '').toLowerCase() === 'critical';

      const station = stationId
        ? await db.station.findByPk(stationId, {
            attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
          })
        : null;
      const postSite = (postSiteId || station?.postSiteId)
        ? await db.businessInfo.findByPk(postSiteId || station?.postSiteId, {
            attributes: ['id', 'companyName', 'address', 'city', 'contactPhone', 'latitud', 'longitud'],
          })
        : null;

      const lat = data.latitude ?? station?.latitud ?? postSite?.latitud ?? null;
      const lng = data.longitude ?? station?.longitud ?? postSite?.longitud ?? null;
      const stationName = station?.stationName || postSite?.companyName || 'Puesto';
      const siteAddress =
        postSite?.address || postSite?.city || data.location || null;

      dispatch(
        isPanic ? 'panic.alert' : 'incident.created',
        {
          incidentId: incident.id,
          incidentTitle: title,
          title,
          description: data.content || data.description || null,
          guardName: securityGuard ? securityGuard.fullName : null,
          stationName,
          siteName: postSite?.companyName || stationName,
          address: siteAddress,
          phone: postSite?.contactPhone || null,
          latitude: lat,
          longitude: lng,
          mapsUrl: lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : null,
          location: data.location || null,
          priority: data.priority || (isPanic ? 'critical' : 'medium'),
          at: new Date().toISOString(),
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'incident',
          sourceEntityId: incident.id,
        },
      ).catch(() => {});
    } catch (e) {
      console.warn('[guardIncident] dispatch failed', (e as any)?.message || e);
    }

    return ApiResponseHandler.success(req, res, incident.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
