import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Station inspection endpoints (supervisor "Start Inspection" flow).
 *
 *   POST /supervisor/me/stations/:stationId/inspection
 *     body: { result: 'ok'|'issues', notes?, transcription?, latitude?,
 *             longitude?, media?: File[], audio?: File[] }
 *   GET  /supervisor/me/stations/:stationId/inspections   (recent history)
 *
 * Gated `supervisorMe`.
 */

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export const createInspection = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const stationId = String(req.params.stationId);
    const data = (req.body && req.body.data) || req.body || {};

    const station = await db.station.findOne({
      where: { id: stationId, tenantId },
      attributes: ['id'],
    });
    if (!station) throw new Error400(req.language);

    const result = data.result === 'issues' ? 'issues' : 'ok';

    const inspection = await db.stationInspection.create({
      tenantId,
      stationId,
      supervisorUserId: req.currentUser.id,
      result,
      notes: data.notes ? String(data.notes).slice(0, 2000) : null,
      transcription: data.transcription ? String(data.transcription).slice(0, 8000) : null,
      latitude: toNum(data.latitude),
      longitude: toNum(data.longitude),
    });

    const fileOptions: any = {
      database: db,
      currentUser: req.currentUser,
      currentTenant: { id: tenantId },
    };
    const linkFiles = async (files: any, column: string) => {
      const list = Array.isArray(files) ? files : files ? [files] : [];
      if (!list.length) return;
      try {
        await FileRepository.replaceRelationFiles(
          { belongsTo: db.stationInspection.getTableName(), belongsToColumn: column, belongsToId: inspection.id },
          list,
          fileOptions,
        );
      } catch (e: any) {
        console.warn(`[supervisor.createInspection] link ${column} failed:`, e?.message || e);
      }
    };
    await linkFiles(data.media, 'media');
    await linkFiles(data.audio, 'audio');

    await ApiResponseHandler.success(req, res, {
      inspection: { id: inspection.id, result },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const listInspections = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const stationId = String(req.params.stationId);

    const rows = await db.stationInspection.findAll({
      where: { tenantId, stationId },
      attributes: ['id', 'result', 'notes', 'transcription', 'createdAt'],
      include: [{ model: db.user, as: 'supervisor', attributes: ['id', 'firstName', 'lastName'], required: false }],
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    const inspections = rows.map((r: any) => {
      const u = r.supervisor || null;
      return {
        id: String(r.id),
        result: r.result,
        notes: r.notes || null,
        transcription: r.transcription || null,
        at: r.createdAt,
        by: u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null,
      };
    });

    await ApiResponseHandler.success(req, res, { inspections });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
