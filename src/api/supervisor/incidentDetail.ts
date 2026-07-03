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
    reportedBy: guard ? { name: guard.fullName, role: 'guard', avatar: reporterAvatar } : null,
    assignedTo: assignee ? { id: String(assignee.id), name: assigneeName, role: 'supervisor' } : null,
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

async function mutate(req: any, res: any, apply: (r: any, log: LogEvent[]) => Promise<void> | void) {
  new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
  const db = req.database;
  const r = await loadIncident(db, req.currentTenant.id, String(req.params.incidentId));
  if (!r) throw new Error400(req.language);
  const log = parseLog(r.comments);
  await apply(r, log);
  r.comments = log; // JSON column
  await r.save();
  const fresh = await loadIncident(db, req.currentTenant.id, String(r.id));
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
    });
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
    await mutate(req, res, (r, log) => {
      // DB enum is binary; resolved/closed → cerrado, else abierto.
      r.status = status === 'resolved' || status === 'closed' ? 'cerrado' : 'abierto';
      const labels: Record<string, string> = { open: 'Open', inProgress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };
      log.push({ type: 'status', title: 'Status Updated', value: status, text: `Status changed to ${labels[status]}`, by: actorName(req), at: new Date().toISOString() });
    });
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
    });
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
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
