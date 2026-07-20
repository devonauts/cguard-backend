import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import Error403 from '../../errors/Error403';
import Error404 from '../../errors/Error404';
import FileRepository from '../../database/repositories/fileRepository';

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;

/**
 * Load an incident and confirm it belongs to the client in the path. An incident
 * links to a client the same way clientAccountIncidentsBoard scopes them: by its
 * own clientId, OR by its station (station.postSiteId ∈ the client's sedes / an
 * origin-linked station), OR by its postSiteId. Checking only tenantId (the old
 * behaviour) let client A read/mutate client B's incident via A's route.
 * Returns the loaded incident instance. Throws 404 (unknown/other tenant) or
 * 403 (exists but another client's).
 */
async function loadIncidentForClient(req: any, incidentId: string, clientAccountId: string): Promise<any> {
  const db = req.database;
  const Op = db.Sequelize.Op;
  const tenantId = req.currentTenant && req.currentTenant.id;
  if (!incidentId || !clientAccountId) throw new Error404(req.language);

  const inc: any = await db.incident.findByPk(incidentId).catch(() => null);
  if (!inc || String(inc.tenantId) !== String(tenantId)) throw new Error404(req.language);

  // Direct client link.
  if (inc.clientId && String(inc.clientId) === String(clientAccountId)) return inc;

  // Indirect via the client's sedes/stations (mirrors the board's linkOr).
  const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id'] }).catch(() => []);
  const siteIds = sedeRows.map((s: any) => String(s.id));
  if (inc.postSiteId && siteIds.includes(String(inc.postSiteId))) return inc;
  if (inc.stationId) {
    const station: any = await db.station.findByPk(inc.stationId, { attributes: ['id', 'postSiteId', 'stationOriginId'] }).catch(() => null);
    if (station) {
      if (station.postSiteId && siteIds.includes(String(station.postSiteId))) return inc;
      if (station.stationOriginId && String(station.stationOriginId) === String(clientAccountId)) return inc;
    }
  }
  // Exists in this tenant but not this client's incident.
  throw new Error403(req.language);
}

/** GET evidence (photos/videos) for one incident. */
export const evidence = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;

    // The incident must belong to the client in the path, not merely the tenant
    // — otherwise client A could read client B's evidence via A's route.
    await loadIncidentForClient(req, req.params.incidentId, req.params.id);

    const files = await db.file.findAll({
      where: { belongsTo: db.incident.getTableName(), belongsToColumn: 'imageUrl', belongsToId: req.params.incidentId, deletedAt: null },
      order: [['createdAt', 'ASC']],
    }).catch(() => []);
    let filled: any[] = [];
    try { filled = await FileRepository.fillDownloadUrl(files); } catch { filled = []; }

    const items = (filled || []).map((f: any) => ({
      id: String(f.id || ''),
      url: f.downloadUrl || f.publicUrl || null,
      name: f.name || f.filename || 'Evidencia',
      isVideo: VIDEO_EXT.test(f.name || f.filename || ''),
      createdAt: f.createdAt || null,
    })).filter((f: any) => f.url);

    return ApiResponseHandler.success(req, res, { items });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** PATCH the work status of one incident (open | inProgress | resolved). */
export const updateStatus = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentEdit);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const raw = req.body?.data || req.body || {};
    const ws = String(raw.workStatus || '').trim();
    const ALLOWED = ['open', 'inProgress', 'resolved', 'closed'];
    if (!ALLOWED.includes(ws)) return ApiResponseHandler.error(req, res, { code: 400, message: 'invalid workStatus' });

    // The incident must belong to the client in the path — not just the tenant —
    // else client A could flip the status of client B's incident via A's route.
    const inc: any = await loadIncidentForClient(req, req.params.incidentId, req.params.id);

    // Keep the legacy binary `status` in sync with the finer workStatus.
    const status = (ws === 'resolved' || ws === 'closed') ? 'cerrado' : 'abierto';
    await inc.update({ workStatus: ws, status });

    return ApiResponseHandler.success(req, res, { id: inc.id, workStatus: ws, status });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
