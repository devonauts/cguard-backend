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
import { stationIdsForGuard } from '../../services/assignedStationsService';

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
      const assignedIds = await stationIdsForGuard(db, tenantId, userId);
      const station = assignedIds.length
        ? await db.station
            .findOne({
              where: { tenantId, deletedAt: null, id: assignedIds },
              attributes: ['id', 'postSiteId'],
            })
            .catch(() => null)
        : null;
      if (station) {
        stationId = station.id;
        postSiteId = postSiteId || station.postSiteId;
      }
    }

    // SAFETY fallback (critical for PANIC/SOS): if the guard has no resolved
    // station/post (assignment gap — exactly when a panic may fire), resolve
    // from their MOST RECENT shift so the alert still reaches the client app and
    // the client-detail incidents board instead of silently dropping the client leg.
    if (!stationId && !postSiteId && securityGuard?.id) {
      try {
        const lastShift = await db.guardShift.findOne({
          where: { tenantId, guardNameId: securityGuard.id, deletedAt: null },
          order: [['punchInTime', 'DESC']],
          attributes: ['stationNameId', 'postSiteId'],
        });
        if (lastShift) {
          stationId = stationId || (lastShift as any).stationNameId || null;
          postSiteId = postSiteId || (lastShift as any).postSiteId || null;
        }
      } catch { /* best-effort */ }
    }

    // Resolve the owning client so the incident is directly linked (clientId) —
    // it then shows on the client-detail incidents board and the client push has
    // a guaranteed recipient — even when only thin station data is available.
    let clientAccountId: string | null = data.clientId || null;
    if (!clientAccountId && postSiteId) {
      try {
        const site = await db.businessInfo.findByPk(postSiteId, { attributes: ['clientAccountId'] });
        clientAccountId = (site as any)?.clientAccountId || null;
      } catch { /* best-effort */ }
    }
    if (!clientAccountId && stationId) {
      try {
        const st = await db.station.findByPk(stationId, { attributes: ['stationOriginId'] });
        clientAccountId = (st as any)?.stationOriginId || null;
      } catch { /* best-effort */ }
    }

    // Resolve the incident type. The app sends incidentTypeId when the chosen
    // label matched the tenant catalog; when it didn't (label drift, new
    // tenant, custom taxonomy), it also sends incidentTypeName — find-or-create
    // the catalog row by name so the TYPE is never silently lost.
    let incidentTypeId = data.incidentTypeId || null;
    if (!incidentTypeId && data.incidentTypeName && db.incidentType) {
      try {
        const name = String(data.incidentTypeName).trim().slice(0, 255);
        if (name) {
          const [typeRow] = await db.incidentType.findOrCreate({
            where: { tenantId, name },
            defaults: { name, active: true, tenantId, createdById: userId },
          });
          incidentTypeId = typeRow?.id || null;
        }
      } catch { /* type resolution is best-effort */ }
    }

    const incident = await db.incident.create({
      title,
      subject: data.subject || title,
      content: data.content || data.description || null,
      description: data.description || data.content || null,
      priority: data.priority || 'medium',
      status: data.status || 'abierto',
      location: data.location || null,
      // Guard's GPS fix at creation (nullable). Was sent by the app and
      // discarded — now persisted so CRM/client can see WHERE it happened.
      latitude: data.latitude != null && !isNaN(Number(data.latitude)) ? Number(data.latitude) : null,
      longitude: data.longitude != null && !isNaN(Number(data.longitude)) ? Number(data.longitude) : null,
      // `date` is NOT NULL on the incident model.
      date: data.incidentAt ? new Date(data.incidentAt) : new Date(),
      incidentAt: data.incidentAt || new Date(),
      dateTime: data.incidentAt || new Date(),
      incidentTypeId,
      stationId,
      postSiteId,
      clientId: clientAccountId,
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
            // MUST match the association scope (models.incident.getTableName()
            // = 'incidents'). The old literal 'incident' (singular) created the
            // file rows under a key no reader queries — every evidence photo
            // was stored but invisible to the CRM, the client and the app.
            belongsTo: db.incident.getTableName(),
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
    let notifyClientAfterAck: (() => Promise<void>) | null = null;
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

      // A worker-app PANIC becomes a persistent Alarm-queue case (origin 'worker_app'),
      // mirroring the customer SOS — so it's acknowledged/dispatched/resolved with an
      // audit trail and the overlay's RECONOCER can acknowledge THIS case. Best-effort.
      let workerCaseId: string | null = null;
      if (isPanic) {
        try {
          const caseTitle = `🚨 Pánico Vigilante — ${securityGuard ? securityGuard.fullName : 'Vigilante'} · ${stationName}`;
          const ac = await db.alarmCase.create({
            status: 'queued', priority: 1, category: 'panic', title: caseTitle.slice(0, 200),
            source: 'worker_app',
            incidentId: incident.id,
            postSiteId: postSiteId || station?.postSiteId || null,
            stationId: stationId || null,
            tenantId, createdById: userId, updatedById: userId,
          });
          workerCaseId = String(ac.id);
          try {
            const { emitAlarmEvent } = require('../../services/alarm/realtime');
            await emitAlarmEvent(db, tenantId, {
              eventType: 'alarm.case.new', title: caseTitle, body: data.content || title, caseId: workerCaseId,
              payload: { source: 'worker_app', guardName: securityGuard?.fullName, stationName, incidentId: incident.id, priority: 1, category: 'panic' },
            });
          } catch { /* emit best-effort; the 20s queue poll still picks it up */ }
        } catch (e) {
          console.warn('[guardPanic] alarm case create failed:', (e as any)?.message || e);
        }
      }

      dispatch(
        isPanic ? 'panic.alert' : 'incident.created',
        {
          incidentId: incident.id,
          caseId: workerCaseId,
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

      // Notify the owning CLIENT (Mi Seguridad app) that an incident was reported at
      // their site — with the evidence photo when present. Best-effort. Deferred
      // until AFTER the guard's HTTP ack (it resolves photo files + recipients).
      notifyClientAfterAck = async () => {
        try {
          const { notifyClient } = require('../../services/clientNotifyService');
          let photoUrl = '';
          try {
            const imgFiles = await db.file.findAll({
              where: { belongsTo: db.incident.getTableName(), belongsToColumn: 'imageUrl', belongsToId: incident.id },
            });
            const filled = await FileRepository.fillDownloadUrl(imgFiles);
            photoUrl = (filled[0] && (filled[0].downloadUrl || filled[0].publicUrl)) || '';
          } catch { /* photo optional */ }

          await notifyClient(db, tenantId, { clientAccountId, postSiteId, stationId }, {
            eventType: 'incident.created',
            title: isPanic ? '🚨 Alerta de pánico' : 'Nuevo incidente',
            body: `${title}${stationName ? ` — ${stationName}` : ''}.`,
            image: photoUrl || undefined,
            data: {
              incidentId: String(incident.id || ''),
              incidentTitle: String(title || ''),
              stationName: String(stationName || ''),
              guardName: securityGuard ? String(securityGuard.fullName || '') : '',
              priority: String(data.priority || (isPanic ? 'critical' : 'medium')),
              photoUrl: String(photoUrl || ''),
              stationId: String(stationId || ''),
              postSiteId: String(postSiteId || ''),
            },
            sourceEntityType: 'incident',
            sourceEntityId: String(incident.id),
          });
        } catch (e) {
          console.warn('[guardIncident] client notify failed:', (e as any)?.message || e);
        }
      };
    } catch (e) {
      console.warn('[guardIncident] dispatch failed', (e as any)?.message || e);
    }

    // Email the tenant's admins/supervisors so they're aware of the incident.
    // Best-effort; mailService throws when no transport is configured, so this
    // only sends when email is actually set up. Deferred until AFTER the ack —
    // the tenantUser scan + SMTP round-trip must not delay the guard's report.
    const emailAdminsAfterAck = async () => {
      try {
        const { Op } = db.Sequelize;
        const targetRoles = ['admin', 'owner', 'operationsManager', 'securitySupervisor', 'dispatcher'];
        // Coarse LIKE pre-filter on the serialized roles array (superset — the
        // exact role check below still decides) + lean attributes, so a 10k-user
        // tenant doesn't hydrate every row just to find a few admin emails.
        const tenantUsers = await db.tenantUser.findAll({
          where: {
            tenantId,
            [Op.or]: targetRoles.map((r: string) => ({ roles: { [Op.like]: `%${r}%` } })),
          },
          attributes: ['id', 'roles'],
          include: [{ model: db.user, as: 'user', attributes: ['email'] }],
        });
        const emails = Array.from(new Set(
          (tenantUsers || [])
            .filter((tu: any) => {
              const roles = Array.isArray(tu.roles)
                ? tu.roles
                : (typeof tu.roles === 'string' ? tu.roles.split(',').map((r: string) => r.trim()) : []);
              return roles.some((r: string) => targetRoles.includes(r)) && tu.user && tu.user.email;
            })
            .map((tu: any) => tu.user.email),
        ));
        if (emails.length) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { sendMail } = require('../../services/mailService');
          const guardName = securityGuard ? securityGuard.fullName : 'Un guardia';
          const sev = String(data.priority || 'medium');
          const desc = data.content || data.description || '';
          const text = `${guardName} reportó un incidente: "${title}" (prioridad: ${sev}). ${desc}`.trim();
          const html =
            `<p style="font-size:15px"><strong>Nuevo incidente reportado</strong></p>` +
            `<p>${guardName} reportó: <strong>${title}</strong> (prioridad: ${sev}).</p>` +
            (desc ? `<blockquote style="margin:10px 0;padding:8px 12px;border-left:3px solid #C8860A;color:#374151">${String(desc)}</blockquote>` : '') +
            (data.location ? `<p>Ubicación: ${data.location}</p>` : '') +
            `<p style="color:#6b7280;font-size:12px;margin-top:12px">CGuardPro · ${new Date().toLocaleString('es')}</p>`;
          await sendMail({ to: emails, subject: `Incidente reportado: ${title}`, html, text });
        }
      } catch (e: any) {
        console.warn('[guardIncident] email notify skipped/failed:', e?.message || e);
      }
    };

    // The guard's app needs a sub-second ack (this is the panic path): the
    // incident + alarm case are persisted and the panic.alert socket dispatch
    // already fired above, so run the remaining fan-out (client push + admin
    // email — DB scans and an SMTP round-trip) AFTER the response.
    setImmediate(() => {
      (async () => {
        if (notifyClientAfterAck) await notifyClientAfterAck();
        await emailAdminsAfterAck();
      })().catch((e: any) => console.warn('[guardIncident] post-ack notify failed:', e?.message || e));
    });

    return ApiResponseHandler.success(req, res, incident.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
