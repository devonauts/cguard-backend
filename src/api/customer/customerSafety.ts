/**
 * Client-app safety endpoints (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). These EXPOSE already-captured data to the
 * customer scope and add two customer actions (SOS + escalate). Every query is
 * strictly scoped to the customer's own stations (resolved from
 * clientAccount → businessInfo(postSites) → stations, plus stations directly
 * owned via station.stationOriginId), mirroring reportRepository.
 *
 *   POST /customer/sos                       panic button → HIGH incident + CRM + guard push
 *   GET  /customer/guard-locations           last-known on-duty guard positions (live map)
 *   GET  /customer/clock-ins                 geofenced clock-in proof feed
 *   POST /customer/incident/:id/escalate     customer raises an incident → CRM + guard push
 *
 * Push/CRM-notify is ALWAYS best-effort: wrapped in try/catch so a notification
 * failure never fails the main request.
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import { dispatch } from '../../lib/notificationDispatcher';
import { stationGuardUserIds } from '../../services/taskNotify';
import { pushToUser } from '../../services/pushService';
import FileRepository from '../../database/repositories/fileRepository';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/**
 * The set of stationIds the customer is allowed to touch. A station belongs to a
 * customer if EITHER it is under one of the customer's post-sites
 * (businessInfo.clientAccountId → station.postSiteId) OR it is directly owned via
 * station.stationOriginId. Mirrors customerTaskCreate's resolution.
 * Returns { stationIds, stations } where stations carry id/name/coords.
 */
async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();

  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));

  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }

  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
      })
    : [];

  return { stationIds: ids, stations };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /customer/sos — panic button
// ─────────────────────────────────────────────────────────────────────────────
export const customerSos = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};
    const message = String(b.message || '').trim();
    const latitude = b.latitude != null && b.latitude !== '' ? Number(b.latitude) : null;
    const longitude = b.longitude != null && b.longitude !== '' ? Number(b.longitude) : null;

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    // Resolve the target station: explicit stationId (must belong to the customer),
    // else a station under the explicit postSiteId, else the customer's first station.
    let stationId: string | null = null;
    if (b.stationId && stationById.has(String(b.stationId))) {
      stationId = String(b.stationId);
    } else if (b.postSiteId) {
      const match = stations.find((s: any) => String(s.postSiteId) === String(b.postSiteId));
      if (match) stationId = String(match.id);
    }
    if (!stationId && stationIds.length) stationId = stationIds[0];

    const station = stationId ? stationById.get(stationId) : null;
    const stationName = (station && station.stationName) || 'el puesto';

    // Client name + the post-site id for CRM scoping.
    let clientName = 'el cliente';
    let postSiteId: string | null = station ? (station.postSiteId || null) : null;
    try {
      const ca = await db.clientAccount.findByPk(clientAccountId, { attributes: ['name', 'lastName'] });
      if (ca) clientName = [ca.name, ca.lastName].filter(Boolean).join(' ').trim() || clientName;
    } catch { /* non-fatal */ }

    const title = '🆘 SOS — Solicitud de emergencia del cliente';
    const descParts = [
      message || 'El cliente activó el botón de pánico.',
      `Cliente: ${clientName}.`,
      `Puesto: ${stationName}.`,
    ];
    if (latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)) {
      descParts.push(`Ubicación: ${latitude}, ${longitude}.`);
    }
    const description = descParts.join(' ');

    // incident model: priority is a free STRING (no enum) → 'alta' (highest the app
    // uses). status enum is only abierto|cerrado → 'abierto'. No clientAccountId
    // column → the FK is `clientId`. No `source` column → recorded in description +
    // callerType. `date` + `title` + `description` are NOT NULL. location stores the
    // raw coordinates when provided.
    const incident = await db.incident.create({
      date: new Date(),
      title,
      description,
      priority: 'alta',
      status: 'abierto',
      callerName: clientName,
      callerType: 'client',
      clientId: clientAccountId,
      stationId: stationId,
      postSiteId: postSiteId,
      location:
        latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)
          ? `${latitude},${longitude}`
          : null,
      wasRead: false,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    const incidentId = String(incident.id);

    // ── CRM notify: fire the dedicated `panic.alert` (NOT a plain incident.created)
    // so the dashboard shows the full-screen red PanicAlertOverlay + wails the SOS
    // siren — the SAME alarm a guard's panic button triggers. Broad (no post-site
    // scoping) so every operator hears it. Best-effort; never fails the request.
    try {
      let postSiteInfo: any = null;
      if (postSiteId) {
        try {
          postSiteInfo = await db.businessInfo.findByPk(postSiteId, {
            attributes: ['companyName', 'address', 'city', 'contactPhone', 'latitud', 'longitud'],
          });
        } catch { /* non-fatal */ }
      }
      const lat = latitude ?? (station && station.latitud) ?? (postSiteInfo && postSiteInfo.latitud) ?? null;
      const lng = longitude ?? (station && station.longitud) ?? (postSiteInfo && postSiteInfo.longitud) ?? null;
      const address = (postSiteInfo && (postSiteInfo.address || postSiteInfo.city)) || null;

      dispatch(
        'panic.alert',
        {
          incidentId,
          incidentTitle: title,
          title,
          description,
          source: 'client',
          clientName,
          // Shown in the overlay's actor row — labelled as the client, not a guard.
          guardName: `Cliente: ${clientName}`,
          stationName,
          siteName: (postSiteInfo && postSiteInfo.companyName) || stationName,
          address,
          phone: (postSiteInfo && postSiteInfo.contactPhone) || null,
          latitude: lat,
          longitude: lng,
          mapsUrl: lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : null,
          location:
            latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)
              ? `${latitude},${longitude}`
              : null,
          priority: 'critical',
          at: new Date().toISOString(),
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'incident',
          sourceEntityId: incidentId,
        },
      ).catch(() => undefined);
    } catch { /* never fail the request on notify */ }

    // ── Persistent Alarm-queue CASE — so the SOS is a real, actionable, acknowledged
    // case with an audit trail in the Centro de Alarmas, even if no operator had a tab
    // open at the moment it fired. Highest priority + 'panic' category (ECV-exempt).
    // Best-effort; never fails the request. emitAlarmEvent lights up the live queue.
    try {
      const caseTitle = `🆘 SOS Cliente — ${clientName} · ${stationName}`;
      const alarmCase = await db.alarmCase.create({
        status: 'queued',
        priority: 1,
        category: 'panic',
        title: caseTitle.slice(0, 200),
        incidentId,
        postSiteId,
        stationId,
        customerId: clientAccountId,
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
      try {
        const { emitAlarmEvent } = require('../../services/alarm/realtime');
        await emitAlarmEvent(db, tenantId, {
          eventType: 'alarm.case.new',
          title: caseTitle,
          body: description,
          caseId: String(alarmCase.id),
          payload: { source: 'client', clientName, stationName, incidentId, priority: 1, category: 'panic' },
        });
      } catch { /* emit is best-effort; the 20s queue poll still picks it up */ }
    } catch (e) {
      console.warn('[customerSos] alarm case create failed:', (e as any)?.message || e);
    }

    // ── Guard push (best-effort; never fail the request on a push error).
    (async () => {
      try {
        const guardIds = stationId ? await stationGuardUserIds(db, tenantId, stationId) : [];
        await Promise.all(
          guardIds.map((uid) =>
            pushToUser(db, tenantId, uid, {
              title: '🆘 SOS de cliente',
              body: `${stationName}${message ? ` — ${message}` : ''}`,
              timeSensitive: true,
              data: {
                type: 'sos',
                incidentId,
                stationId: String(stationId || ''),
              },
            }).catch(() => undefined),
          ),
        );
      } catch { /* non-fatal */ }
    })();

    return ApiResponseHandler.success(req, res, { success: true, incidentId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /customer/guard-locations — last-known on-duty guard positions
// ─────────────────────────────────────────────────────────────────────────────
export const customerGuardLocations = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, { guards: [] });
    }
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    // Open shifts (clocked in, no punchOutTime) AT the customer's stations. The
    // guardShift station FK column is `stationNameId` (belongsTo alias
    // `stationName`); the guard FK is `guardNameId`. Mirrors the on-duty query in
    // /operations/activities.
    const shifts = await db.guardShift.findAll({
      where: {
        ...(tenantId ? { tenantId } : {}),
        punchOutTime: null,
        deletedAt: null,
        stationNameId: { [Op.in]: stationIds },
      },
      attributes: [
        'id', 'guardNameId', 'stationNameId', 'punchInTime',
        'punchInLatitude', 'punchInLongitude', 'punchInDistanceM',
      ],
      order: [['punchInTime', 'DESC']],
    });

    // One entry per guard (most-recent open shift wins).
    const byGuard = new Map<string, any>();
    for (const s of shifts || []) {
      const gid = String(s.guardNameId || '');
      if (!gid || byGuard.has(gid)) continue;
      byGuard.set(gid, s);
    }

    const guardIds = Array.from(byGuard.keys());
    const guardRecords = guardIds.length
      ? await db.securityGuard.findAll({
          where: { id: { [Op.in]: guardIds } },
          attributes: ['id', 'fullName', 'guardId'],
        })
      : [];
    const guardById = new Map<string, any>(guardRecords.map((g: any) => [String(g.id), g]));

    // Profile photos (same source/shape as customerAccountMe guard photos).
    const photoByGuard = new Map<string, string>();
    try {
      const photos = guardIds.length
        ? await db.file.findAll({
            where: {
              belongsTo: db.securityGuard.getTableName(),
              belongsToId: guardIds,
              belongsToColumn: 'profileImage',
              deletedAt: null,
            },
            attributes: ['belongsToId', 'publicUrl', 'privateUrl'],
          })
        : [];
      for (const p of photos || []) {
        const url = p.publicUrl || p.privateUrl || null;
        if (url && !photoByGuard.has(String(p.belongsToId))) photoByGuard.set(String(p.belongsToId), url);
      }
    } catch { /* non-fatal */ }

    const guards = guardIds.map((gid) => {
      const shift = byGuard.get(gid);
      const guard = guardById.get(gid) || {};
      const station = stationById.get(String(shift.stationNameId)) || {};
      const hasPunch =
        shift.punchInLatitude != null && shift.punchInLongitude != null;
      const latitude = hasPunch ? shift.punchInLatitude : (station.latitud ?? null);
      const longitude = hasPunch ? shift.punchInLongitude : (station.longitud ?? null);
      return {
        id: guard.id || gid,
        fullName: guard.fullName || null,
        guardId: guard.guardId || null,
        stationId: shift.stationNameId || null,
        stationName: station.stationName || null,
        latitude,
        longitude,
        onDutySince: shift.punchInTime || null,
        photoUrl: photoByGuard.get(gid) || null,
        distanceFromStationM: shift.punchInDistanceM ?? null,
        source: hasPunch ? 'punch' : 'station',
      };
    });

    return ApiResponseHandler.success(req, res, { guards });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /customer/clock-ins — geofenced clock-in proof feed
// ─────────────────────────────────────────────────────────────────────────────
export const customerClockIns = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
    const days = Math.min(Math.max(parseInt(q.days, 10) || 7, 1), 90);

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db.guardShift.findAll({
      where: {
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
        stationNameId: { [Op.in]: stationIds },
        punchInTime: { [Op.gte]: since },
      },
      attributes: [
        'id', 'guardNameId', 'stationNameId',
        'punchInTime', 'punchInLatitude', 'punchInLongitude',
        'punchInPhoto', 'punchInAddress', 'punchInDistanceM', 'lateMinutes',
        'punchOutTime', 'punchOutLatitude', 'punchOutLongitude',
      ],
      order: [['punchInTime', 'DESC']],
      limit,
    });

    const guardIds = Array.from(
      new Set((rows || []).map((r: any) => String(r.guardNameId || '')).filter(Boolean)),
    );
    const guardRecords = guardIds.length
      ? await db.securityGuard.findAll({
          where: { id: { [Op.in]: guardIds } },
          attributes: ['id', 'fullName'],
        })
      : [];
    const guardNameById = new Map<string, string>(
      guardRecords.map((g: any) => [String(g.id), g.fullName || '']),
    );

    // punchInPhoto is a plain TEXT column on guardShift (a stored URL/path), NOT a
    // FileRepository file relation, so it is returned as-is. (If a deployment ever
    // stores file ids here, sign them with FileRepository.fillDownloadUrl — imported
    // and available for that path.)
    const out = (rows || []).map((r: any) => {
      const station = stationById.get(String(r.stationNameId)) || {};
      return {
        id: r.id,
        guardName: guardNameById.get(String(r.guardNameId)) || null,
        stationName: station.stationName || null,
        punchInTime: r.punchInTime || null,
        punchInLatitude: r.punchInLatitude ?? null,
        punchInLongitude: r.punchInLongitude ?? null,
        punchInPhoto: r.punchInPhoto || null,
        punchInAddress: r.punchInAddress || null,
        punchInDistanceM: r.punchInDistanceM ?? null,
        lateMinutes: r.lateMinutes ?? null,
        punchOutTime: r.punchOutTime || null,
        punchOutLatitude: r.punchOutLatitude ?? null,
        punchOutLongitude: r.punchOutLongitude ?? null,
      };
    });

    // Reference FileRepository so the signing path stays wired even though the
    // current column is plain text (keeps the import live for file-id deployments).
    void FileRepository;

    return ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /customer/incident/:id/escalate — customer escalates an incident
// ─────────────────────────────────────────────────────────────────────────────
export const customerIncidentEscalate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const incidentId = req.params.id;
    const b = req.body?.data || req.body || {};
    const note = String(b.note || '').trim();

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    const incident = await db.incident.findOne({
      where: { id: incidentId, ...(tenantId ? { tenantId } : {}), deletedAt: null },
    });
    if (!incident) throw new Error404();

    // The incident must belong to one of the customer's stations OR directly to the
    // customer (clientId). Anything else is a 404 (don't leak other clients' data).
    const incidentStationId = incident.stationId ? String(incident.stationId) : null;
    const belongsByStation = !!incidentStationId && stationById.has(incidentStationId);
    const belongsByClient = String(incident.clientId || '') === String(clientAccountId);
    if (!belongsByStation && !belongsByClient) throw new Error404();

    const station = incidentStationId ? stationById.get(incidentStationId) : null;
    const stationName = (station && station.stationName) || 'el puesto';

    // Mark escalated: raise priority to highest ('alta') and append the customer's
    // note to the incident's `comments` JSON (the model's notes-like column). There
    // is no boolean "escalated" flag column, so the escalation is recorded as a
    // structured comment entry — visible to the CRM in the incident timeline.
    let comments: any[] = [];
    try {
      const existing = incident.comments;
      if (Array.isArray(existing)) comments = existing.slice();
      else if (typeof existing === 'string' && existing.trim()) {
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) comments = parsed;
      }
    } catch { comments = []; }
    comments.push({
      type: 'escalation',
      by: 'client',
      clientAccountId,
      note: note || null,
      at: new Date().toISOString(),
    });

    incident.priority = 'alta';
    incident.comments = comments;
    if (note) {
      const stamp = `[Escalado por el cliente] ${note}`;
      incident.internalNotes = incident.internalNotes
        ? `${incident.internalNotes}\n${stamp}`
        : stamp;
    }
    incident.updatedById = userId;
    await incident.save();

    // ── CRM notify (urgent) — same dispatcher the CRM uses for incidents.
    try {
      dispatch(
        'incident.updated',
        {
          incidentTitle: incident.title,
          description: note
            ? `Escalado por el cliente: ${note}`
            : 'El cliente escaló este incidente.',
          guardName: null,
          siteName: stationName,
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'incident',
          sourceEntityId: String(incident.id),
          ...(station && station.postSiteId ? { assignedPostSiteId: station.postSiteId } : {}),
        },
      ).catch(() => undefined);
    } catch { /* never fail the request on notify */ }

    // ── Guard push (best-effort).
    (async () => {
      try {
        const guardIds = incidentStationId
          ? await stationGuardUserIds(db, tenantId, incidentStationId)
          : [];
        await Promise.all(
          guardIds.map((uid) =>
            pushToUser(db, tenantId, uid, {
              title: 'Incidente escalado por el cliente',
              body: `${stationName}${note ? ` — ${note}` : ''}`,
              timeSensitive: true,
              data: {
                type: 'incident_escalated',
                incidentId: String(incident.id),
                stationId: String(incidentStationId || ''),
              },
            }).catch(() => undefined),
          ),
        );
      } catch { /* non-fatal */ }
    })();

    return ApiResponseHandler.success(req, res, { success: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
