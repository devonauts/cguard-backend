import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import FileRepository from '../../database/repositories/fileRepository';

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;

/** GET evidence (photos/videos) for one incident. */
export const evidence = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;

    const inc: any = await db.incident.findByPk(req.params.incidentId, { attributes: ['id', 'tenantId'] });
    if (!inc || (tenantId && inc.tenantId && inc.tenantId !== tenantId)) return ApiResponseHandler.error(req, res, { code: 404 });

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
    const tenantId = req.currentTenant && req.currentTenant.id;
    const raw = req.body?.data || req.body || {};
    const ws = String(raw.workStatus || '').trim();
    const ALLOWED = ['open', 'inProgress', 'resolved', 'closed'];
    if (!ALLOWED.includes(ws)) return ApiResponseHandler.error(req, res, { code: 400, message: 'invalid workStatus' });

    const inc: any = await db.incident.findByPk(req.params.incidentId);
    if (!inc || (tenantId && inc.tenantId && inc.tenantId !== tenantId)) return ApiResponseHandler.error(req, res, { code: 404 });

    // Keep the legacy binary `status` in sync with the finer workStatus.
    const status = (ws === 'resolved' || ws === 'closed') ? 'cerrado' : 'abierto';
    await inc.update({ workStatus: ws, status });

    return ApiResponseHandler.success(req, res, { id: inc.id, workStatus: ws, status });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
