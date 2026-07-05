import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import FileRepository from '../../database/repositories/fileRepository';
import {
  normSeverity, severityLevel, parseLog, statusFromLog, referenceFor,
  LogEvent, WorkStatus, Severity,
} from './incidentShared';

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function actorName(req: any): string {
  const u = req.currentUser || {};
  return `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Supervisor';
}

async function fileUrl(files: any): Promise<any> {
  try {
    if (Array.isArray(files) && files.length) {
      const filled = await FileRepository.fillDownloadUrl(files);
      return filled;
    }
  } catch { /* ignore */ }
  return [];
}

/** Load an incident (tenant-scoped) with everything the detail screen needs. */
async function loadIncident(db: any, tenantId: string, id: string) {
  return db.incident.findOne({
    where: { id, tenantId },
    include: [
      { model: db.station, as: 'station', attributes: ['id', 'stationName', 'latitud', 'longitud'], required: false },
      {
        model: db.businessInfo, as: 'site', required: false,
        attributes: ['id', 'companyName', 'address', 'city', 'latitud', 'longitud'],
      },
      {
        model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: false,
        include: [{ model: db.file, as: 'profileImage', required: false }],
      },
      { model: db.incidentType, as: 'incidentType', attributes: ['id', 'name'], required: false },
      { model: db.user, as: 'assignedTo', attributes: ['id', 'firstName', 'lastName'], required: false },
      { model: db.user, as: 'createdBy', attributes: ['id', 'firstName', 'lastName'], required: false },
      { model: db.file, as: 'imageUrl', required: false },
    ],
  });
}

async function serialize(db: any, r: any) {
  const id = String(r.id);
  const log = parseLog(r.comments);
  const severity = normSeverity(r.priority) as Severity;
  const status = statusFromLog(log, r.status) as WorkStatus;
  const createdAt = r.incidentAt || r.dateTime || r.createdAt;

  const stationName = r.station ? r.station.stationName : null;
  const postName = r.site ? r.site.companyName : null;
  const address = r.site ? [r.site.address, r.site.city].filter(Boolean).join(', ') || null : null;
  const rawSub = r.location ? String(r.location).trim() : '';
  const looksLikeCoords = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(rawSub);
  const subLabel = (looksLikeCoords ? '' : rawSub) || postName;
  const location = [stationName, subLabel].filter(Boolean).join(' – ') || subLabel || stationName || null;

  // Coordinates: location "lat,lng" → post → station.
  let lat: number | null = null, lng: number | null = null;
  if (looksLikeCoords) { const [a, b] = rawSub.split(','); lat = toNum(a); lng = toNum(b); }
  if (lat == null) { lat = toNum(r.site?.latitud) ?? toNum(r.station?.latitud); lng = toNum(r.site?.longitud) ?? toNum(r.station?.longitud); }

  // Photos (all, resolved).
  const filledPhotos = await fileUrl(r.imageUrl);
  const photos = filledPhotos.map((f: any) => ({ downloadUrl: f.downloadUrl || null, privateUrl: f.privateUrl || null, name: f.name || null }));

  // Reporter.
  const guard = r.guardName || null;
  let reporterAvatar: any = null;
  if (guard && Array.isArray(guard.profileImage) && guard.profileImage.length) {
    const a = await fileUrl(guard.profileImage);
    reporterAvatar = a[0] || null;
  }
  const assignee = r.assignedTo || null;
  const assigneeName = assignee ? `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim() : null;

  // Reporter: the reporting guard → caller (CRM phone report) → the creating user.
  const createdByName = r.createdBy ? `${r.createdBy.firstName || ''} ${r.createdBy.lastName || ''}`.trim() : null;
  const reporterName = (guard && guard.fullName) || r.callerName || createdByName || null;
  const reporterRole = guard ? 'guard' : (r.callerType || 'staff');

  // ── Timeline: synthesized events + the activity log, sorted ascending ──
  const synth: any[] = [];
  synth.push({ type: 'reported', title: 'Incident Reported', text: `${guard?.fullName || 'Guardia'} reported an incident`, at: createdAt });
  if (photos.length) synth.push({ type: 'photo', title: 'Photo Captured', text: `${photos.length} photo(s) attached`, at: createdAt, photos: photos.slice(0, 4) });
  if (lat != null && lng != null) synth.push({ type: 'location', title: 'Location Recorded', text: location, at: createdAt, lat, lng });
  const logEvents = log.map((e: LogEvent) => ({
    type: e.type, title: e.title || e.type, text: e.text || null, value: e.value || null, by: e.by || null, at: e.at || null,
  }));
  const timeline = [...synth, ...logEvents].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());

  // statusSince — last status event, else created.
  const lastStatusEvt = [...log].reverse().find((e) => e.type === 'status');
  const sinceAt = (lastStatusEvt && lastStatusEvt.at) || createdAt;

  const impactLabel = severity === 'critical' ? 'Critical' : severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';

  return {
    id,
    reference: referenceFor(id, r.createdAt),
    title: r.subject || (r.incidentType ? r.incidentType.name : null) || 'Incidente',
    severity,
    severityLevel: severityLevel(severity),
    status,
    statusSinceAt: sinceAt,
    at: createdAt,
    location,
    address,
    lat, lng,
    photo: photos[0] || null,
    photos,
    reportedBy: reporterName ? { name: reporterName, role: reporterRole, avatar: reporterAvatar } : null,
    details: {
      description: r.content || r.description || null,
      actionsTaken: r.actionsTaken || r.action || null,
      caller: r.callerName || null,
      callerType: r.callerType || null,
    },
    assignedTo: assignee ? { id: String(assignee.id), name: assigneeName, role: 'supervisor' } : null,
    assignedToUserId: r.assignedToUserId ? String(r.assignedToUserId) : null,
    dispatchStatus: r.dispatchStatus || null,
    site: { station: stationName, post: subLabel || postName },
    incidentType: r.incidentType ? r.incidentType.name : null,
    summary: {
      text: r.content || r.subject || null,
      potentialImpact: impactLabel,
      suspectedCause: null,
      peopleInvolved: null,
      estimatedLoss: null,
    },
    notes: log.filter((e: LogEvent) => e.type === 'note').map((e: LogEvent) => ({ text: e.text, by: e.by, at: e.at })),
    timeline,
    counts: {
      evidence: photos.length,
      notes: log.filter((e: LogEvent) => e.type === 'note').length,
      tasks: 0,
    },
  };
}

/** GET /supervisor/me/incidents/:incidentId */
export const getIncidentDetail = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const r = await loadIncident(req.database, req.currentTenant.id, String(req.params.incidentId));
    if (!r) return ApiResponseHandler.success(req, res, { incident: null });
    await ApiResponseHandler.success(req, res, { incident: await serialize(req.database, r) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

async function mutate(
  req: any,
  res: any,
  apply: (r: any, log: LogEvent[]) => Promise<void> | void,
  buildDispatch?: (r: any) => { eventType: string; data: any } | null,
) {
  new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
  const db = req.database;
  const tenantId = req.currentTenant.id;
  const r = await loadIncident(db, tenantId, String(req.params.incidentId));
  if (!r) throw new Error400(req.language);
  const log = parseLog(r.comments);
  await apply(r, log);
  r.comments = log; // JSON column
  await r.save();
  const fresh = await loadIncident(db, tenantId, String(r.id));

  // CRM notification activity for the action (best-effort).
  if (buildDispatch) {
    try {
      const info = buildDispatch(fresh);
      if (info) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { dispatch } = require('../../lib/notificationDispatcher');
        dispatch(
          info.eventType,
          {
            supervisorName: actorName(req),
            incidentTitle: fresh.subject || null,
            stationName: fresh.station ? fresh.station.stationName : null,
            ...info.data,
          },
          { database: db, tenantId, sourceEntityType: 'incident', sourceEntityId: String(fresh.id) },
        ).catch(() => undefined);
      }
    } catch { /* dispatch best-effort */ }
  }

  await ApiResponseHandler.success(req, res, { incident: await serialize(db, fresh) });
}

/** POST /supervisor/me/incidents/:incidentId/note { text } */
export const addIncidentNote = async (req: any, res: any) => {
  try {
    const data = (req.body && req.body.data) || req.body || {};
    const text = String(data.text || '').trim();
    if (!text) throw new Error400(req.language, 'validation.required');
    await mutate(req, res, (r, log) => {
      log.push({ type: 'note', title: 'Note Added', text, by: actorName(req), at: new Date().toISOString() });
      r.internalNotes = text;
    }, () => ({ eventType: 'supervisor.incident.note', data: {} }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/incidents/:incidentId/status { status } */
export const setIncidentStatus = async (req: any, res: any) => {
  try {
    const data = (req.body && req.body.data) || req.body || {};
    const status = String(data.status || '');
    if (!['open', 'inProgress', 'resolved', 'closed'].includes(status)) throw new Error400(req.language);
    const labels: Record<string, string> = { open: 'Open', inProgress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };
    await mutate(req, res, (r, log) => {
      // Persist the granular 4-state so the CRM sees it, and keep the binary
      // enum in sync (resolved/closed → cerrado, else abierto).
      r.workStatus = status;
      r.status = status === 'resolved' || status === 'closed' ? 'cerrado' : 'abierto';
      log.push({ type: 'status', title: 'Status Updated', value: status, text: `Status changed to ${labels[status]}`, by: actorName(req), at: new Date().toISOString() });
    }, () => ({ eventType: 'supervisor.incident.status', data: { status, statusLabel: labels[status] } }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/incidents/:incidentId/assign { userId, name? } */
export const assignIncident = async (req: any, res: any) => {
  try {
    const data = (req.body && req.body.data) || req.body || {};
    const userId = data.userId ? String(data.userId) : null;
    await mutate(req, res, (r, log) => {
      r.assignedToUserId = userId;
      log.push({ type: 'assign', title: 'Assigned', text: data.name ? `Assigned to ${data.name}` : 'Reassigned', by: actorName(req), at: new Date().toISOString() });
    }, () => ({ eventType: 'supervisor.incident.assigned', data: { assigneeName: data.name || null } }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/incidents/:incidentId/escalate */
export const escalateIncident = async (req: any, res: any) => {
  try {
    await mutate(req, res, (r, log) => {
      const order: Severity[] = ['low', 'medium', 'high', 'critical'];
      const cur = normSeverity(r.priority);
      const next = order[Math.min(order.length - 1, order.indexOf(cur) + 1)];
      r.priority = next;
      log.push({ type: 'escalate', title: 'Escalated', text: `Severity raised to ${next}`, by: actorName(req), at: new Date().toISOString() });
    }, (r) => ({ eventType: 'supervisor.incident.escalated', data: { severity: normSeverity(r.priority) } }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * POST /supervisor/me/incidents/:incidentId/respond { status: accepted|enRoute|onScene }
 * The dispatched supervisor acknowledges: accept → en route → on scene. Notifies
 * admins/ops in realtime (storePlatformEvent — no template needed).
 */
export const respondDispatch = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const data = (req.body && req.body.data) || req.body || {};
    const status = String(data.status || '');
    if (!['accepted', 'enRoute', 'onScene'].includes(status)) throw new Error400(req.language);
    const labels: Record<string, string> = { accepted: 'Aceptado', enRoute: 'En camino', onScene: 'En sitio' };

    const r = await loadIncident(db, tenantId, String(req.params.incidentId));
    if (!r) throw new Error400(req.language);
    const log = parseLog(r.comments);
    log.push({ type: 'dispatch', title: 'Despacho', value: status, text: `Supervisor: ${labels[status]}`, by: actorName(req), at: new Date().toISOString() });
    r.dispatchStatus = status;
    r.comments = log;
    await r.save();

    try {
      const { storePlatformEvent } = require('../../lib/platformEventStore');
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'supervisor.incident.dispatchResponse',
        title: 'Respuesta de supervisor',
        body: `${actorName(req)}: ${labels[status]}`,
        targetRoles: 'admin,operationsManager',
        sourceEntityType: 'incident',
        sourceEntityId: String(r.id),
        payload: { incidentId: String(r.id), status },
      });
    } catch { /* realtime best-effort */ }

    const fresh = await loadIncident(db, tenantId, String(r.id));
    await ApiResponseHandler.success(req, res, { incident: await serialize(db, fresh) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
