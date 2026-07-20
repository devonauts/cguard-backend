import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import assertClientOwnsSubResource from '../../services/user/assertClientOwnsSubResource';
import FileRepository from '../../database/repositories/fileRepository';

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;

/** GET evidence (photos/videos) for one incident. */
export const evidence = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;

    // The incident must belong to the client in the path, not merely the tenant
    // — otherwise client A could read client B's evidence via A's route.
    await assertClientOwnsSubResource(req, {
      model: db.incident, subId: req.params.incidentId,
      clientAccountId: req.params.id, clientKey: 'clientId',
    });

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
    const inc: any = await assertClientOwnsSubResource(req, {
      model: db.incident, subId: req.params.incidentId,
      clientAccountId: req.params.id, clientKey: 'clientId',
    });

    // Keep the legacy binary `status` in sync with the finer workStatus.
    const status = (ws === 'resolved' || ws === 'closed') ? 'cerrado' : 'abierto';
    await inc.update({ workStatus: ws, status });

    return ApiResponseHandler.success(req, res, { id: inc.id, workStatus: ws, status });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
