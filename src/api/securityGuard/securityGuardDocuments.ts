import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Documents for a security guard — generic files linked polymorphically to the
 * securityGuard row (belongsTo='securityGuards', belongsToColumn='documents').
 * The frontend uploads to storage first (getting a file descriptor) then POSTs
 * the descriptor here to persist it. Photos/PDFs/etc. of the worker.
 *
 *   GET    /tenant/:tenantId/security-guard/:id/documents
 *   POST   /tenant/:tenantId/security-guard/:id/documents   { data: { documents: [descriptor...] } }
 *   DELETE /tenant/:tenantId/security-guard/:id/documents/:docId
 *
 * :id may be the securityGuard.id (PK) or the guard's user id.
 */
const BELONGS_TO = 'securityGuards';
const COLUMN = 'documents';

async function resolveSgId(db: any, tenantId: string, incomingId: string): Promise<string | null> {
  let sg = await db.securityGuard.findOne({ where: { id: incomingId, tenantId }, attributes: ['id'] });
  if (!sg) sg = await db.securityGuard.findOne({ where: { guardId: incomingId, tenantId }, attributes: ['id'] });
  return sg ? String(sg.id) : null;
}

export async function list(req: any, res: any) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const sgId = await resolveSgId(db, tenantId, req.params.id);
    if (!sgId) return ApiResponseHandler.success(req, res, { rows: [], count: 0 });

    const rows = await db.file.findAll({
      where: { tenantId, belongsTo: BELONGS_TO, belongsToColumn: COLUMN, belongsToId: sgId },
      order: [['createdAt', 'DESC']],
    });
    let plain = (rows || []).map((r: any) => r.get({ plain: true }));
    try { plain = await FileRepository.fillDownloadUrl(plain); } catch { /* keep raw */ }
    await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

export async function create(req: any, res: any) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const currentUser = req.currentUser;
    const sgId = await resolveSgId(db, tenantId, req.params.id);
    if (!sgId) return ApiResponseHandler.error(req, res, new Error('Vigilante no encontrado'));

    const body = (req.body && (req.body.data || req.body)) || {};
    const docs = Array.isArray(body.documents) ? body.documents : (body.document ? [body.document] : []);
    if (!docs.length) return ApiResponseHandler.error(req, res, new Error('Sin documentos para guardar'));

    const created: any[] = [];
    for (const d of docs) {
      if (!d) continue;
      const row = await db.file.create({
        belongsTo: BELONGS_TO,
        belongsToColumn: COLUMN,
        belongsToId: sgId,
        name: d.name || d.title || 'documento',
        sizeInBytes: d.sizeInBytes != null ? d.sizeInBytes : (d.size != null ? d.size : null),
        privateUrl: d.privateUrl || d.private_url || null,
        publicUrl: d.publicUrl || d.public_url || null,
        tenantId,
        createdById: currentUser?.id || null,
        updatedById: currentUser?.id || null,
      });
      created.push(row.get({ plain: true }));
    }
    let plain = created;
    try { plain = await FileRepository.fillDownloadUrl(created); } catch { /* keep raw */ }
    await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

export async function destroy(req: any, res: any) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const sgId = await resolveSgId(db, tenantId, req.params.id);
    const docId = req.params.docId;
    const row = await db.file.findOne({ where: { id: docId, tenantId, belongsTo: BELONGS_TO, belongsToColumn: COLUMN, ...(sgId ? { belongsToId: sgId } : {}) } });
    if (!row) return ApiResponseHandler.error(req, res, new Error('Documento no encontrado'));
    await row.destroy({ force: true });
    await ApiResponseHandler.success(req, res, { id: docId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}
