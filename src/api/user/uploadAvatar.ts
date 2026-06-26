import PermissionChecker from '../../services/user/permissionChecker';
import Storage from '../../security/storage';
import FileStorage from '../../services/file/fileStorage';
import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import fs from 'fs';
import os from 'os';
import path from 'path';

export default async (req, res) => {
  try {
    const permissionChecker = new PermissionChecker(req);

    if (!req.currentUser || !req.currentUser.id) {
      throw new Error403();
    }

    if (!req.currentTenant || !req.currentTenant.id) {
      throw new Error403();
    }

    const targetUserId = req.params.id;
    // Allow users to upload their own avatar or admins with `userEdit` permission.
    if (String(req.currentUser.id) !== String(targetUserId)) {
      const Permissions = require('../../security/permissions').default;
      permissionChecker.validateHas(Permissions.values.userEdit);
    }

    const file = (req as any).file;
    if (!file) {
      throw Object.assign(new Error('File is required'), { code: 400 });
    }

    const storageConfig = Storage.values['userAvatarsProfiles'];
    if (!storageConfig) {
      throw new Error('Storage config not found');
    }

    const ext = path.extname(file.originalname) || '';
    const filename = `avatar${ext}`;

    let privateUrl = `${storageConfig.folder}/${filename}`;
    privateUrl = privateUrl.replace(':tenantId', req.currentTenant.id);
    privateUrl = privateUrl.replace(':userId', targetUserId);

    // Write buffer to temp file
    const tmpPath = path.join(os.tmpdir(), `upload-${Date.now()}-${filename}`);
    fs.writeFileSync(tmpPath, file.buffer);

    // Upload to configured FileStorage
    try {
      if (typeof FileStorage.upload === 'function') {
        await FileStorage.upload(tmpPath, privateUrl);
      } else {
        const LocalStorage = require('../../services/file/localhostFileStorage').default;
        await LocalStorage.upload(tmpPath, privateUrl);
      }
    } catch (err) {
      // cleanup tmp
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      throw err;
    }

    // Build downloadUrl
    const mount = req.baseUrl || '/api';
    const baseUrl = `${req.protocol}://${req.get('host')}${mount}`;
    const downloadUrl = await FileStorage.downloadUrl(privateUrl, baseUrl);

    // Persist DB records inside a transaction
    const sequelize = req.database.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const fileRecord = await req.database.file.create(
        {
          belongsTo: 'user',
          belongsToColumn: 'avatars',
          belongsToId: targetUserId,
          name: filename,
          sizeInBytes: file.size,
          privateUrl: privateUrl,
          mimeType: file.mimetype,
          tenantId: req.currentTenant.id,
          createdById: req.currentUser.id,
          updatedById: req.currentUser.id,
        },
        { transaction },
      );

      await req.database.user.update(
        { avatarUrl: downloadUrl },
        { where: { id: targetUserId }, transaction },
      );

      await transaction.commit();

      await ApiResponseHandler.success(req, res, { file: fileRecord.get({ plain: true }), downloadUrl });
    } catch (error) {
      await transaction.rollback();
      // Attempt to delete uploaded file from storage
      try {
        await FileStorage.delete(privateUrl);
      } catch (e) {}
      throw error;
    } finally {
      // cleanup tmp
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
