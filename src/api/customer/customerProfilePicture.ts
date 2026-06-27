/**
 * POST /api/customer/me/profile-picture
 *
 * Lets a "Mi Seguridad" customer upload/replace their own profile picture.
 * The image becomes the clientAccount's `logoUrl` (the avatar shown in the app's
 * Mi Seguridad header), so the very next GET /customer/me/account returns it in
 * `clientAccount.logoUrl[].downloadUrl`.
 *
 * Auth: customer JWT (currentUser.clientAccountId) — same context as customerTasks.ts.
 * NOT permission-gated.
 *
 * Request: multipart/form-data with a single file field named `file`.
 *   The route applies `multer().single('file')` so `req.file` (memory storage,
 *   `{ buffer, originalname, size, mimetype }`) is available.
 *
 * Response 200: { success: true, downloadUrl: "<signed url>" }
 *   400 on missing file; 404 on missing clientAccount.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import FileStorage from '../../services/file/fileStorage';
import FileRepository from '../../database/repositories/fileRepository';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) {
    const err: any = new Error('No autenticado');
    err.code = 401;
    throw err;
  }
  const clientAccountId = u.clientAccountId;
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/**
 * Persists the uploaded binary using the active FileStorage provider.
 * FileStorage.upload(fileTempPath, privateUrl) takes a file PATH and MOVES it,
 * so we first write the multer in-memory buffer to a temp file.
 *
 * NOTE: the GCP/AWS providers do not expose `upload`; we replicate the exact
 * fallback used by FileRepository.createLegalDocument (fall back to the local
 * storage uploader) so this keeps working on every configured provider.
 */
async function storeBinary(buffer: Buffer, originalname: string, privateUrl: string) {
  const safeName = String(originalname || 'upload').replace(/[^A-Za-z0-9._-]/g, '_');
  const tempPath = path.join(
    os.tmpdir(),
    `customer-logo-${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`,
  );
  fs.writeFileSync(tempPath, buffer);
  try {
    if (typeof (FileStorage as any).upload === 'function') {
      await (FileStorage as any).upload(tempPath, privateUrl);
    } else {
      const LocalStorage = require('../../services/file/localhostFileStorage').default;
      await LocalStorage.upload(tempPath, privateUrl);
    }
  } finally {
    // FileStorage.upload moves the temp file on success; clean up if it remains.
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (e) {
      /* best-effort */
    }
  }
}

export default async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);

    if (!clientAccountId) {
      return res.status(404).json({ success: false, error: 'clientAccount no encontrado' });
    }

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ success: false, error: 'Archivo requerido (campo "file")' });
    }

    // Confirm the clientAccount exists (and is in this tenant) before mutating files.
    const clientAccount = await db.clientAccount.findOne({
      where: { id: clientAccountId, ...(tenantId ? { tenantId } : {}) },
      attributes: ['id', 'tenantId'],
    });
    if (!clientAccount) {
      return res.status(404).json({ success: false, error: 'clientAccount no encontrado' });
    }

    const belongsTo = db.clientAccount.getTableName();
    const belongsToColumn = 'logoUrl';
    const originalname = String(file.originalname || 'logo');
    const privateUrl =
      `tenant/${tenantId}/clientAccount/logoUrl/${Date.now()}-${originalname}`.replace(/[^A-Za-z0-9._/-]/g, '_');

    // 1. Store the binary via the active FileStorage provider.
    await storeBinary(file.buffer, originalname, privateUrl);

    // 2. Soft-delete every existing logoUrl file row for this clientAccount so the
    //    new picture REPLACES any previous one (paranoid soft-delete on the model).
    const existing = await db.file.findAll({
      where: { belongsTo, belongsToId: clientAccountId, belongsToColumn, deletedAt: null },
    });
    for (const old of existing) {
      try {
        await old.destroy();
      } catch (e) {
        /* best-effort; never block the replace on a stale row */
      }
    }

    // 3. Create the new logoUrl file row (same shape customerAccountMe queries).
    const created = await db.file.create({
      belongsTo,
      belongsToId: clientAccountId,
      belongsToColumn,
      name: originalname,
      privateUrl,
      sizeInBytes: file.size || file.buffer.length,
      mimeType: file.mimetype || null,
      tenantId,
      createdById: userId || null,
      updatedById: userId || null,
    });

    // 4. Build the signed downloadUrl exactly like customerAccountMe does.
    const [withUrl] = await FileRepository.fillDownloadUrl([created]);
    const downloadUrl = withUrl && withUrl.downloadUrl ? withUrl.downloadUrl : null;

    return res.status(200).json({ success: true, downloadUrl });
  } catch (error: any) {
    const status = error && error.code === 401 ? 401 : 500;
    return res
      .status(status)
      .json({ success: false, error: (error && error.message) || 'Error al subir la imagen' });
  }
};
