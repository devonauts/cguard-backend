import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import FileRepository from './fileRepository';
import _get from 'lodash/get';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';
import FileStorage from '../../services/file/fileStorage';
import { IRepositoryOptions } from './IRepositoryOptions';

export default class SettingsRepository {

  static async findOrCreateDefault(defaults, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const [
      settings,
    ] = await options.database.settings.findOrCreate({
      where: { id: tenant.id, tenantId: tenant.id },
      defaults: {
        ...defaults,
        id: tenant.id,
        tenantId: tenant.id,
        createdById: currentUser ? currentUser.id : null,
      },
      transaction: SequelizeRepository.getTransaction(
        options,
      ),
    });

    return this._fillWithRelationsAndFiles(
      settings,
      options,
    );
  }

  static async save(data, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    data.backgroundImageUrl = _get(
      data,
      'backgroundImages[0].downloadUrl',
      null,
    );
    data.logoUrl = _get(data, 'logos[0].downloadUrl', null);

    const [
      settings,
    ] = await options.database.settings.findOrCreate({
      where: { id: tenant.id, tenantId: tenant.id },
      defaults: {
        ...data,
        id: tenant.id,
        tenantId: tenant.id,
        createdById: currentUser ? currentUser.id : null,
      },
      transaction,
    });

    await settings.update(data, {
      transaction,
    });

    // If client provided base64 images in data.logos, process and upload them
    try {
      const StorageConfig = require('../../security/storage').default;
      const storageCfg = StorageConfig.values['settingsLogos'];

      if (Array.isArray(data.logos) && data.logos.length > 0) {
        for (let i = 0; i < data.logos.length; i++) {
          const f = data.logos[i];
          const b64 = f && (f.base64 || f.dataUrl || f.dataURI || f.data);
          if (!b64) continue;

          try {
            let matches = String(b64).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
            let mimeType = 'image/png';
            let base64Data = String(b64);

            if (matches) {
              mimeType = matches[1];
              base64Data = matches[2];
            }

            const ext = mimeType.split('/').pop() || 'png';
            const filename = `${uuid()}.${ext}`;

            let privateUrl = `${storageCfg.folder}/${filename}`;
            privateUrl = privateUrl.replace(':tenantId', tenant.id);
            privateUrl = privateUrl.replace(':userId', currentUser ? currentUser.id : '0');

            const buffer = Buffer.from(base64Data, 'base64');
            const tmpPath = path.join(os.tmpdir(), filename);
            fs.writeFileSync(tmpPath, buffer);

            try {
              if (typeof FileStorage.upload === 'function') {
                await FileStorage.upload(tmpPath, privateUrl);
              } else {
                const LocalStorage = require('../../services/file/localhostFileStorage').default;
                await LocalStorage.upload(tmpPath, privateUrl);
              }
            } finally {
              try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
            }

            const fileRecord = await options.database.file.create({
              belongsTo: options.database.settings.getTableName(),
              belongsToColumn: 'logos',
              belongsToId: settings.id,
              name: filename,
              sizeInBytes: buffer.length,
              privateUrl: privateUrl,
              mimeType: mimeType,
              tenantId: tenant.id,
              createdById: currentUser ? currentUser.id : null,
              updatedById: currentUser ? currentUser.id : null,
            }, { transaction });

            // Replace base64 entry with existing file reference so replaceRelationFiles won't duplicate
            data.logos[i] = { id: fileRecord.id };
          } catch (err) {
            console.warn('Failed to process base64 logo entry:', err && err.message ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.warn('settingsRepository: base64 handling failed', err && err.message ? err.message : err);
    }

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.settings.getTableName(),
        belongsToColumn: 'logos',
        belongsToId: settings.id,
      },
      data.logos,
      options,
    );

    // After replacing logo files, ensure settings.logoUrl is set to
    // the first logo's downloadUrl and persist the file id into tenant.logoId
    try {
      const logoFiles = await options.database.file.findAll({
        where: {
          belongsTo: options.database.settings.getTableName(),
          belongsToId: settings.id,
          belongsToColumn: 'logos',
        },
        order: [['createdAt', 'DESC']],
        transaction,
      });

      const logosWithUrl = await FileRepository.fillDownloadUrl(
        logoFiles,
      );

      const firstLogo = logosWithUrl && logosWithUrl.length ? logosWithUrl[0] : null;

      if (firstLogo && firstLogo.downloadUrl) {
        try {
          await settings.update({ logoUrl: firstLogo.downloadUrl }, { transaction });
        } catch (e) {
          // ignore non-fatal
        }
      }

      if (firstLogo && firstLogo.id) {
        try {
          await options.database.tenant.update(
            { logoId: firstLogo.id },
            { where: { id: tenant.id }, transaction },
          );
        } catch (e) {
          // ignore non-fatal
        }
      }
    } catch (error) {
      console.warn('Failed to update tenant.logoId or settings.logoUrl:', error && error.message ? error.message : error);
    }

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.settings.getTableName(),
        belongsToColumn: 'backgroundImages',
        belongsToId: settings.id,
      },
      data.backgroundImages,
      options,
    );

    // Replace legal documents relation if provided
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.settings.getTableName(),
        belongsToColumn: 'legalDocuments',
        belongsToId: settings.id,
      },
      data.legalDocuments,
      options,
    );

    await AuditLogRepository.log(
      {
        entityName: 'settings',
        entityId: settings.id,
        action: AuditLogRepository.UPDATE,
        values: data,
      },
      options,
    );

    return await this._fillWithRelationsAndFiles(
      settings,
      options,
    );
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    output.logos = await FileRepository.fillDownloadUrl(
      await record.getLogos({
        transaction,
      }),
    );

    output.backgroundImages = await FileRepository.fillDownloadUrl(
      await record.getBackgroundImages({
        transaction,
      }),
    );

    // Attach legal documents with downloadUrl
    output.legalDocuments = await FileRepository.fillDownloadUrl(
      await record.getLegalDocuments({
        transaction,
      }),
    );

    return output;
  }
}
