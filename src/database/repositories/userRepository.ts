import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import FileRepository from './fileRepository';
import AuditLogRepository from './auditLogRepository';
import crypto from 'crypto';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { isUserInTenant } from '../utils/userTenantUtils';
import { getConfig } from '../../config';
import { IRepositoryOptions } from './IRepositoryOptions';
import SequelizeArrayUtils from '../utils/sequelizeArrayUtils';
import lodash from 'lodash';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';
import FileStorage from '../../services/file/fileStorage';
import { syncIdentityFromUser } from '../../services/identitySync';

const Op = Sequelize.Op;

export default class UserRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const createData: any = {
      id: data.id || undefined,
      email: data.email,
      // Persist any provided fullName directly so callers that only
      // send fullName (instead of firstName/lastName) are handled.
      fullName: data.fullName ?? null,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      phoneNumber: data.phoneNumber ?? null,
      importHash: data.importHash ?? null,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    };

    // If only fullName is provided, derive firstName/lastName so they are persisted
    if (
      (createData.firstName === null || createData.firstName === undefined) &&
      (createData.lastName === null || createData.lastName === undefined) &&
      data.fullName
    ) {
      const parts = String(data.fullName).trim().split(/\s+/);
      if (parts.length === 1) {
        createData.firstName = parts[0];
        createData.lastName = null;
      } else {
        createData.firstName = parts.shift();
        createData.lastName = parts.join(' ');
      }
    }

    // Debugging aid: log what will be created when running in development
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.debug('UserRepository.create payload:', {
          email: createData.email,
          fullName: createData.fullName,
          firstName: createData.firstName,
          lastName: createData.lastName,
        });
      }
    } catch (e) {
      // ignore logging errors
    }

    const user = await options.database.user.create(
      createData,
      { transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.user.getTableName(),
        belongsToColumn: 'avatars',
        belongsToId: user.id,
      },
      data.avatars,
      options,
    );

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.CREATE,
        values: {
          ...user.get({ plain: true }),
          avatars: data.avatars,
        },
      },
      options,
    );

    return this.findById(user.id, {
      ...options,
      bypassPermissionValidation: true,
    });
  }

  static async createFromAuth(
    data,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Map only allowed fields from incoming data to avoid unexpected DB writes
    const createData: any = {
      id: data.id || undefined,
      fullName: data.fullName ?? undefined,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      phoneNumber: data.phoneNumber ?? null,
      importHash: data.importHash ?? null,
      email: data.email,
      password: data.password,
      emailVerified: typeof data.emailVerified !== 'undefined' ? data.emailVerified : false,
      emailVerificationToken: data.emailVerificationToken ?? null,
      emailVerificationTokenExpiresAt: data.emailVerificationTokenExpiresAt ?? null,
      provider: data.provider ?? null,
      providerId: data.providerId ?? null,
      passwordResetToken: data.passwordResetToken ?? null,
      passwordResetTokenExpiresAt: data.passwordResetTokenExpiresAt ?? null,
      jwtTokenInvalidBefore: data.jwtTokenInvalidBefore ?? null,
      // createdAt/updatedAt/deletedAt/createdById/updatedById are managed by Sequelize or audit, avoid forcing them here
    };

    // If fullName is provided but firstName/lastName are missing,
    // derive them from fullName so the model hooks buildFullName
    // will produce the expected `fullName` value and DB rows
    // contain `firstName` and `lastName`.
    if ((createData.firstName === null || createData.firstName === undefined) &&
      (createData.lastName === null || createData.lastName === undefined) &&
      createData.fullName) {
      const parts = String(createData.fullName).trim().split(/\s+/);
      if (parts.length === 1) {
        createData.firstName = parts[0];
        createData.lastName = null;
      } else {
        createData.firstName = parts.shift();
        createData.lastName = parts.join(' ');
      }
    }

    const user = await options.database.user.create(
      createData,
      { transaction },
    );

    delete user.password;
    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.CREATE,
        values: {
          ...user.get({ plain: true }),
          avatars: data.avatars,
        },
      },
      options,
    );

    return this.findById(user.id, {
      ...options,
      bypassPermissionValidation: true,
    });
  }

  static async updateProfile(
    id,
    data,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findByPk(id, {
      transaction,
    });

    await user.update(
      {
        firstName: data.firstName || null,
        lastName: data.lastName || null,
        phoneNumber: data.phoneNumber || null,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    // If client provided base64 images in data.avatars, process and upload them
    try {
      const StorageConfig = require('../../security/storage').default;
      const storageCfg = StorageConfig.values['userAvatarsProfiles'];

      if (Array.isArray(data.avatars) && data.avatars.length > 0) {
        for (let i = 0; i < data.avatars.length; i++) {
          const f = data.avatars[i];
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
            privateUrl = privateUrl.replace(':userId', user.id);

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

            const currentTenant = SequelizeRepository.getCurrentTenant(options);

            const fileRecord = await options.database.file.create({
              belongsTo: options.database.user.getTableName(),
              belongsToColumn: 'avatars',
              belongsToId: user.id,
              name: filename,
              sizeInBytes: buffer.length,
              privateUrl: privateUrl,
              mimeType: mimeType,
              tenantId: currentTenant ? currentTenant.id : null,
              createdById: currentUser ? currentUser.id : null,
              updatedById: currentUser ? currentUser.id : null,
            }, { transaction });

            // Replace base64 entry with existing file reference so replaceRelationFiles won't duplicate
            data.avatars[i] = { id: fileRecord.id };
          } catch (err) {
            console.warn('Failed to process base64 avatar entry:', err && err.message ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.warn('userRepository: base64 avatar handling failed', err && err.message ? err.message : err);
    }

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.user.getTableName(),
        belongsToColumn: 'avatars',
        belongsToId: user.id,
      },
      data.avatars,
      options,
    );

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          ...user.get({ plain: true }),
          avatars: data.avatars,
        },
      },
      options,
    );

    // Single source of identity: propagate to denormalized caches. Best-effort.
    await syncIdentityFromUser(options.database, user.id, options);

    return this.findById(user.id, options);
  }

  static async updatePassword(
    id,
    password,
    invalidateOldTokens: boolean,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findByPk(id, {
      transaction,
    });

    const data: any = {
      password,
      updatedById: currentUser.id,
    };

    if (invalidateOldTokens) {
      data.jwtTokenInvalidBefore = new Date();
    }

    await user.update(data, { transaction });

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          id,
        },
      },
      options,
    );

    return this.findById(user.id, {
      ...options,
      bypassPermissionValidation: true,
    });
  }

  static async generateEmailVerificationToken(
    email,
    options: IRepositoryOptions,
  ) {

    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findOne({
      where: { email },
      transaction,
    });

    if (!user) {
      throw new Error404();
    }


    const emailVerificationToken = crypto
      .randomBytes(20)
      .toString('hex');
    const emailVerificationTokenExpiresAt =
      Date.now() + 24 * 60 * 60 * 1000;

    console.log('🎫 [generateEmailVerificationToken] Token generado:', emailVerificationToken);
    console.log('⏰ [generateEmailVerificationToken] Expira en:', new Date(emailVerificationTokenExpiresAt));

    const updateData: any = {
      emailVerificationToken,
      emailVerificationTokenExpiresAt,
    };

    // updatedById es opcional cuando no hay usuario autenticado
    if (currentUser && currentUser.id) {
      updateData.updatedById = currentUser.id;
    }


    await user.update(updateData, { transaction });


    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          id: user.id,
          emailVerificationToken,
          emailVerificationTokenExpiresAt,
        },
      },
      options,
    );

    return emailVerificationToken;
  }

  static async generatePasswordResetToken(
    email,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findOne({
      where: { email },
      transaction,
    });

    if (!user) {
      throw new Error404();
    }

    const passwordResetToken = crypto
      .randomBytes(20)
      .toString('hex');
    const passwordResetTokenExpiresAt =
      Date.now() + 24 * 60 * 60 * 1000;

    const updateData: any = {
      passwordResetToken,
      passwordResetTokenExpiresAt,
    };

    // updatedById es opcional cuando no hay usuario autenticado
    if (currentUser && currentUser.id) {
      updateData.updatedById = currentUser.id;
    }

    await user.update(updateData, { transaction });

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          id: user.id,
          passwordResetToken,
          passwordResetTokenExpiresAt,
        },
      },
      options,
    );

    return passwordResetToken;
  }

  static async update(
    id,
    data,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findByPk(id, {
      transaction,
    });

    await user.update(
      {
        firstName: data.firstName || null,
        lastName: data.lastName || null,
        phoneNumber: data.phoneNumber || null,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.user.getTableName(),
        belongsToColumn: 'avatars',
        belongsToId: user.id,
      },
      data.avatars,
      options,
    );

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          ...user.get({ plain: true }),
          avatars: data.avatars,
          roles: data.roles,
        },
      },
      options,
    );

    // The user row is the single source of identity. Propagate name/contact
    // changes to the denormalized caches (securityGuard.fullName,
    // clientAccount.name/...). Best-effort, tenant-scoped — never blocks update.
    await syncIdentityFromUser(options.database, user.id, options);

    return this.findById(user.id, options);
  }

  // Partial update: only apply provided fields and relations/files
  static async patchUpdate(
    id,
    data,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const user = await options.database.user.findByPk(id, { transaction });
    if (!user) {
      throw new Error404();
    }

    const updatePayload: any = {};
    if (Object.prototype.hasOwnProperty.call(data, 'firstName')) updatePayload.firstName = data.firstName ?? null;
    if (Object.prototype.hasOwnProperty.call(data, 'lastName')) updatePayload.lastName = data.lastName ?? null;
    if (Object.prototype.hasOwnProperty.call(data, 'phoneNumber')) updatePayload.phoneNumber = data.phoneNumber ?? null;
    // Optional office location for administrative self-attendance (web time clock).
    if (Object.prototype.hasOwnProperty.call(data, 'officeLatitude'))
      updatePayload.officeLatitude = data.officeLatitude === '' || data.officeLatitude == null ? null : Number(data.officeLatitude);
    if (Object.prototype.hasOwnProperty.call(data, 'officeLongitude'))
      updatePayload.officeLongitude = data.officeLongitude === '' || data.officeLongitude == null ? null : Number(data.officeLongitude);
    if (Object.prototype.hasOwnProperty.call(data, 'officeGeofenceRadiusM'))
      updatePayload.officeGeofenceRadiusM = data.officeGeofenceRadiusM === '' || data.officeGeofenceRadiusM == null ? null : Number(data.officeGeofenceRadiusM);
    if (Object.prototype.hasOwnProperty.call(data, 'officeAddress'))
      updatePayload.officeAddress = data.officeAddress ?? null;
    updatePayload.updatedById = currentUser.id;

    if (Object.keys(updatePayload).length) {
      await user.update(updatePayload, { transaction });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'avatars')) {
        // If client provided base64 images in data.avatars, process and upload them
        try {
          const StorageConfig = require('../../security/storage').default;
          const storageCfg = StorageConfig.values['userAvatarsProfiles'];

          if (Array.isArray(data.avatars) && data.avatars.length > 0) {
            for (let i = 0; i < data.avatars.length; i++) {
              const f = data.avatars[i];
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
                privateUrl = privateUrl.replace(':userId', user.id);

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

                const currentTenant = SequelizeRepository.getCurrentTenant(options);

                const fileRecord = await options.database.file.create({
                  belongsTo: options.database.user.getTableName(),
                  belongsToColumn: 'avatars',
                  belongsToId: user.id,
                  name: filename,
                  sizeInBytes: buffer.length,
                  privateUrl: privateUrl,
                  mimeType: mimeType,
                  tenantId: currentTenant ? currentTenant.id : null,
                  createdById: currentUser ? currentUser.id : null,
                  updatedById: currentUser ? currentUser.id : null,
                }, { transaction });

                // Replace base64 entry with existing file reference so replaceRelationFiles won't duplicate
                data.avatars[i] = { id: fileRecord.id };
              } catch (err) {
                console.warn('Failed to process base64 avatar entry:', err && err.message ? err.message : err);
              }
            }
          }
        } catch (err) {
          console.warn('userRepository: base64 avatar handling failed', err && err.message ? err.message : err);
        }

        await FileRepository.replaceRelationFiles(
          {
            belongsTo: options.database.user.getTableName(),
            belongsToColumn: 'avatars',
            belongsToId: user.id,
          },
          data.avatars,
          options,
        );
    }

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          ...user.get({ plain: true }),
          avatars: data.avatars,
          roles: data.roles,
        },
      },
      options,
    );

    // Single source of identity: propagate to denormalized caches. Best-effort.
    await syncIdentityFromUser(options.database, user.id, options);

    return this.findById(user.id, options);
  }

  static async markLoggedIn(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    await options.database.user.update(
      { lastLoginAt: new Date() },
      { where: { id }, transaction },
    );
  }

  static async changeEmail(
    id,
    newEmail: string,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findByPk(id, {
      transaction,
    });

    if (!user) {
      throw new Error404();
    }

    await user.update(
      {
        email: newEmail,
        emailVerified: false,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          email: newEmail,
          emailVerified: false,
        },
      },
      options,
    );

    return user;
  }

  static async findByEmail(
    email,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Build attributes list defensively: include only columns present on the model
    // to avoid querying columns that may not exist in the DB (e.g., isSuperadmin).
    let attributes: string[] | undefined = undefined;
    try {
      const raw = options && options.database && options.database.user && (options.database.user.rawAttributes || options.database.user.attributes);
      if (raw) {
        attributes = Object.keys(raw).filter(Boolean);
      }
    } catch (e) {
      attributes = undefined;
    }

    // If raw attributes were found, ensure they include the standard fields order
    // but avoid relying on DB having `isSuperadmin` (it will be present only if migrated).
    let record;
    try {
      record = await options.database.user.findOne({
        where: {
          [Op.and]: SequelizeFilterUtils.ilikeExact(
            'user',
            'email',
            email,
          ),
        },
        transaction,
        attributes,
      });
    } catch (err: any) {
      // If the DB lacks a column referenced by the model (ER_BAD_FIELD_ERROR),
      // fall back to a raw select that omits the problematic column.
      const code = err && (err.original && err.original.code) || (err.parent && err.parent.code) || (err && err.code);
      const isBadField = code === 'ER_BAD_FIELD_ERROR';
      if (isBadField && options && options.database && options.database.sequelize) {
        try {
          const lowered = String(email).toLowerCase();
          const rows = await options.database.sequelize.query(
            `SELECT id, fullName, firstName, password, emailVerified, emailVerificationToken, emailVerificationTokenExpiresAt, provider, providerId, passwordResetToken, passwordResetTokenExpiresAt, lastName, phoneNumber, email, jwtTokenInvalidBefore, lastLoginAt, importHash, createdAt, updatedAt, deletedAt, createdById, updatedById FROM users WHERE (deletedAt IS NULL AND lower(email) LIKE ?) LIMIT 1`,
            { replacements: [lowered], type: options.database.Sequelize.QueryTypes.SELECT },
          );
          if (Array.isArray(rows) && rows.length) {
            const row = rows[0];
            // Wrap raw row into a minimal Sequelize-like instance with
            // the methods used by _fillWithRelationsAndFiles.
            record = {
              id: row.id,
              get: (_o: any) => row,
              getAvatars: async (opts: any) => {
                try {
                  const tableName = options.database.user.getTableName();
                  return options.database.file.findAll({
                    where: {
                      belongsTo: tableName,
                      belongsToId: row.id,
                      belongsToColumn: 'avatars',
                    },
                    transaction: opts && opts.transaction,
                  });
                } catch (e) {
                  return [];
                }
              },
              getTenants: async (opts: any) => {
                try {
                  const TenantUserRepository = require('../repositories/tenantUserRepository').default;
                  const tenants = await TenantUserRepository.findByUser(row.id, { ...options, transaction: opts && opts.transaction });
                  return tenants;
                } catch (e) {
                  return [];
                }
              },
            } as any;
          } else {
            record = null;
          }
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findByEmailWithoutAvatar(
    email,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Defensive attributes selection as in findByEmail
    let attributes: string[] | undefined = undefined;
    try {
      const raw = options && options.database && options.database.user && (options.database.user.rawAttributes || options.database.user.attributes);
      if (raw) {
        attributes = Object.keys(raw).filter(Boolean);
      }
    } catch (e) {
      attributes = undefined;
    }

    let record;
    try {
      record = await options.database.user.findOne({
        where: {
          [Op.and]: SequelizeFilterUtils.ilikeExact(
            'user',
            'email',
            email,
          ),
        },
        transaction,
        attributes,
      });
    } catch (err: any) {
      const code = err && (err.original && err.original.code) || (err.parent && err.parent.code) || (err && err.code);
      const isBadField = code === 'ER_BAD_FIELD_ERROR';
      if (isBadField && options && options.database && options.database.sequelize) {
        try {
          const lowered = String(email).toLowerCase();
          const rows = await options.database.sequelize.query(
            `SELECT id, fullName, firstName, password, emailVerified, emailVerificationToken, emailVerificationTokenExpiresAt, provider, providerId, passwordResetToken, passwordResetTokenExpiresAt, lastName, phoneNumber, email, jwtTokenInvalidBefore, lastLoginAt, importHash, createdAt, updatedAt, deletedAt, createdById, updatedById FROM users WHERE (deletedAt IS NULL AND lower(email) LIKE ?) LIMIT 1`,
            { replacements: [lowered], type: options.database.Sequelize.QueryTypes.SELECT },
          );
          if (Array.isArray(rows) && rows.length) {
            const row = rows[0];
            record = {
              id: row.id,
              get: (_o: any) => row,
              getAvatars: async (opts: any) => {
                try {
                  const tableName = options.database.user.getTableName();
                  return options.database.file.findAll({
                    where: {
                      belongsTo: tableName,
                      belongsToId: row.id,
                      belongsToColumn: 'avatars',
                    },
                    transaction: opts && opts.transaction,
                  });
                } catch (e) {
                  return [];
                }
              },
              getTenants: async (opts: any) => {
                try {
                  return options.database.tenantUser.findAll({
                    where: { userId: row.id },
                    include: [
                      { model: options.database.tenant, as: 'tenant' },
                      { model: options.database.clientAccount, as: 'assignedClients' },
                      { model: options.database.businessInfo, as: 'assignedPostSites' },
                    ],
                    transaction: opts && opts.transaction,
                  });
                } catch (e) {
                  return [];
                }
              },
            } as any;
          } else {
            record = null;
          }
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findByPhone(
    phoneNumber,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const record = await options.database.user.findOne({
      where: {
        phoneNumber,
      },
      transaction,
    });

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findAndCountAll(
    { filter, limit = 0, offset = 0, orderBy = '' },
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    let whereAnd: Array<any> = [];
    let include: any = [];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    // LEAN list: scoped attribute sets reused across every `tenants` include so we
    // never SELECT * on tenantUser / clientAccount / businessInfo, and we eager-load
    // the `tenant` (id only) so _mapUserForTenant can match without re-querying.
    const tenantUserListInclude = () => [
      { model: options.database.tenant, as: 'tenant', attributes: ['id'], required: false },
      { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id', 'name'], through: { attributes: [] } },
      { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id', 'companyName'], through: { attributes: [] } },
    ];
    const tenantUserListAttributes = ['id', 'userId', 'tenantId', 'roles', 'status', 'invitationTokenExpiresAt'];

    // Exclude users whose current-tenant tenantUser has the `securityGuard` role.
    // This was previously a JS filter in userList.ts that ALSO overwrote
    // `count = filteredRows.length` (corrupting pagination). Push it into the
    // tenantUser WHERE so both rows and count are correct. `roles` is a JSON
    // string-array (mysql) / TEXT[] (postgres); negate the contains check.
    const excludeSecurityGuardRole = () => {
      if (getConfig().DATABASE_DIALECT === 'mysql') {
        // IFNULL(...,0)=0 so users with NULL/empty roles stay visible (the old JS
        // filter kept unparseable roles); only an explicit securityGuard is dropped.
        return Sequelize.where(
          Sequelize.fn(
            'IFNULL',
            Sequelize.fn(
              'JSON_CONTAINS',
              Sequelize.col('tenants.roles'),
              '"securityGuard"',
            ),
            0,
          ),
          0,
        );
      }
      return {
        roles: { [Op.not]: { [Op.contains]: ['securityGuard'] } },
      } as any;
    };

    // Always include tenantUser relation for the current tenant and eagerly load
    // assignedClients and assignedPostSites so the frontend receives pivot data.
    if (!filter || (!filter.role && !filter.status)) {
      include.push({
        model: options.database.tenantUser,
        as: 'tenants',
        attributes: tenantUserListAttributes,
        where: {
          [Op.and]: [
            { ['tenantId']: currentTenant.id },
            excludeSecurityGuardRole(),
          ],
        },
        include: tenantUserListInclude(),
      });
    }

    if (filter) {
      if (filter.id) {
        whereAnd.push({
          ['id']: filter.id,
        });
      }

      if (filter.fullName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'user',
            'fullName',
            filter.fullName,
          ),
        );
      }

      if (filter.email) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'user',
            'email',
            filter.email,
          ),
        );
      }

      if (filter.role) {
        const innerWhereAnd: Array<any> = [];

        innerWhereAnd.push({
          ['tenantId']: currentTenant.id,
        });

        innerWhereAnd.push(
          SequelizeArrayUtils.filter(
            `tenants`,
            `roles`,
            filter.role,
          ),
        );

        // Even when a role filter is supplied, never surface securityGuard users
        // in the office-users list (keeps count consistent with the unfiltered path).
        innerWhereAnd.push(excludeSecurityGuardRole());

        include.push({
          model: options.database.tenantUser,
          as: 'tenants',
          attributes: tenantUserListAttributes,
          where: { [Op.and]: innerWhereAnd },
          include: tenantUserListInclude(),
        });
      }

      if (filter.status) {
        include.push({
          model: options.database.tenantUser,
          as: 'tenants',
          attributes: tenantUserListAttributes,
          where: {
            [Op.and]: [
              { ['tenantId']: currentTenant.id, status: filter.status },
              excludeSecurityGuardRole(),
            ],
          },
          include: tenantUserListInclude(),
        });
      }

      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange;

        if (
          start !== undefined &&
          start !== null &&
          start !== ''
        ) {
          whereAnd.push({
            ['createdAt']: {
              [Op.gte]: start,
            },
          });
        }

        if (
          end !== undefined &&
          end !== null &&
          end !== ''
        ) {
          whereAnd.push({
            ['createdAt']: {
              [Op.lte]: end,
            },
          });
        }
      }
    }

    const where = { [Op.and]: whereAnd };

    let {
      rows,
      count,
    } = await options.database.user.findAndCountAll({
      // LEAN list: explicit root attributes — never SELECT *. Excludes the big
      // providerId(2KB)/token/password columns (password/tokens have undefined
      // getters anyway) and avoids selecting columns that may not exist in every
      // DB (e.g. isSuperadmin). These are exactly what the office-users list +
      // _mapUserForTenant consume. findById keeps the full row.
      attributes: [
        'id', 'fullName', 'firstName', 'lastName', 'middleName',
        'email', 'emailVerified', 'phoneNumber', 'homeAddress',
        'lastLoginAt', 'importHash', 'createdAt', 'updatedAt',
      ],
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy
        ? [orderBy.split('_')]
        : [['email', 'ASC']],
      transaction,
    });

    // LEAN enrichment: build the consumed shape from the ALREADY eager-loaded
    // `tenants` include — no per-row getTenants() re-fetch (was 3N: tenant +
    // settings + assignedClients/PostSites per row), no per-row avatar signing
    // (the list renders no avatars). findById still uses _fillWithRelationsAndFiles.
    rows = this._fillForList(rows);

    rows = this._mapUserForTenantForRows(
      rows,
      currentTenant,
    );

    return { rows, count };
  }

  /**
   * Dedicated LEAN reader for the CSV/PDF/Excel export. The export only renders
   * Name / Email / Phone / Roles, so we skip the whole list enrichment pipeline
   * (no avatars, no settings, no assignedClients/PostSites, no per-row re-fetch).
   * One query: users joined to their current-tenant tenantUser (excluding
   * securityGuard), selecting just the four exported columns + roles.
   */
  static async findAllForExport(
    { filter }: { filter?: any },
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const excludeSecurityGuardRole = () => {
      if (getConfig().DATABASE_DIALECT === 'mysql') {
        return Sequelize.where(
          Sequelize.fn(
            'IFNULL',
            Sequelize.fn(
              'JSON_CONTAINS',
              Sequelize.col('tenants.roles'),
              '"securityGuard"',
            ),
            0,
          ),
          0,
        );
      }
      return { roles: { [Op.not]: { [Op.contains]: ['securityGuard'] } } } as any;
    };

    const whereAnd: Array<any> = [];
    if (filter) {
      if (filter.fullName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('user', 'fullName', filter.fullName));
      }
      if (filter.email) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('user', 'email', filter.email));
      }
    }

    const rows = await options.database.user.findAll({
      attributes: ['id', 'fullName', 'firstName', 'lastName', 'email', 'phoneNumber'],
      where: { [Op.and]: whereAnd },
      include: [
        {
          model: options.database.tenantUser,
          as: 'tenants',
          attributes: ['userId', 'roles'],
          required: true,
          where: {
            [Op.and]: [
              { tenantId: currentTenant.id },
              excludeSecurityGuardRole(),
            ],
          },
        },
      ],
      order: [['email', 'ASC']],
      transaction,
    });

    return rows.map((record) => {
      const plain: any = record.get({ plain: true });
      const tenantUser = Array.isArray(plain.tenants) ? plain.tenants[0] : null;
      let roles: any = tenantUser ? tenantUser.roles : [];
      if (typeof roles === 'string') {
        try { roles = JSON.parse(roles); } catch (e) { roles = []; }
      }
      return {
        id: plain.id,
        fullName: plain.fullName,
        firstName: plain.firstName,
        lastName: plain.lastName,
        email: plain.email,
        phoneNumber: plain.phoneNumber,
        roles: Array.isArray(roles) ? roles : [],
      };
    });
  }

  static async findAllAutocomplete(
    query,
    limit,
    options: IRepositoryOptions,
  ) {
    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [];
    let include = [
      {
        model: options.database.tenantUser,
        as: 'tenants',
        where: {
          ['tenantId']: currentTenant.id,
        },
      },
    ];

    if (query) {
      whereAnd.push({
        [Op.or]: [
          {
            ['id']: SequelizeFilterUtils.uuid(query),
          },
          SequelizeFilterUtils.ilikeIncludes(
            'user',
            'fullName',
            query,
          ),
          SequelizeFilterUtils.ilikeIncludes(
            'user',
            'email',
            query,
          ),
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    let users = await options.database.user.findAll({
      attributes: ['id', 'fullName', 'email'],
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      order: [['fullName', 'ASC']],
    });

    users = this._mapUserForTenantForRows(
      users,
      currentTenant,
    );

    const buildText = (user) => {
      if (!user.fullName) {
        return user.email;
      }

      return `${user.fullName} <${user.email}>`;
    };

    return users.map((user) => ({
      id: user.id,
      label: buildText(user),
    }));
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Eager-load tenantUser relation with assigned clients and post sites.
    // PERF: this include mirrors EXACTLY the one _fillWithRelationsAndFiles
    // uses for its getTenants() fallback, so the fill step can reuse the
    // already-loaded association instead of re-running the same join on every
    // authenticated request (AuthService.findByToken → findById). The tenant
    // is deliberately left-joined (no `required: true`) so a tenant-less user
    // row still loads; the fill step filters out null-tenant rows, which is
    // equivalent to getTenants' `required: true` inner join.
    let record;
    try {
      record = await options.database.user.findByPk(id, {
        transaction,
        include: [
          {
            model: options.database.tenantUser,
            as: 'tenants',
            include: [
              {
                model: options.database.tenant,
                as: 'tenant',
                include: ['settings'],
              },
              {
                model: options.database.clientAccount,
                as: 'assignedClients',
                attributes: ['id', 'name'],
                through: { attributes: [] },
              },
              {
                model: options.database.businessInfo,
                as: 'assignedPostSites',
                attributes: ['id', 'companyName'],
                through: { attributes: [] },
              },
            ],
          },
        ],
      });
    } catch (err: any) {
      const code = err && (err.original && err.original.code) || (err.parent && err.parent.code) || (err && err.code);
      const isBadField = code === 'ER_BAD_FIELD_ERROR';
      if (isBadField && options && options.database && options.database.sequelize) {
        try {
          const rows = await options.database.sequelize.query(
            `SELECT id, fullName, firstName, lastName, password, emailVerified, emailVerificationToken, emailVerificationTokenExpiresAt, provider, providerId, passwordResetToken, passwordResetTokenExpiresAt, phoneNumber, email, jwtTokenInvalidBefore, lastLoginAt, importHash, createdAt, updatedAt, deletedAt, createdById, updatedById FROM users WHERE id = ? LIMIT 1`,
            { replacements: [id], type: options.database.Sequelize.QueryTypes.SELECT },
          );
          if (Array.isArray(rows) && rows.length) {
            const row = rows[0];
            record = {
              id: row.id,
              get: (_o: any) => row,
              getAvatars: async (opts: any) => {
                try {
                  const tableName = options.database.user.getTableName();
                  return options.database.file.findAll({
                    where: {
                      belongsTo: tableName,
                      belongsToId: row.id,
                      belongsToColumn: 'avatars',
                    },
                    transaction: opts && opts.transaction,
                  });
                } catch (e) {
                  return [];
                }
              },
              getTenants: async (opts: any) => {
                try {
                  const TenantUserRepository = require('../repositories/tenantUserRepository').default;
                  const tenants = await TenantUserRepository.findByUser(row.id, { ...options, transaction: opts && opts.transaction });
                  return tenants;
                } catch (e) {
                  return [];
                }
              },
            } as any;
          } else {
            record = null;
          }
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    record = await this._fillWithRelationsAndFiles(
      record,
      options,
    );

    if (!record) {
      throw new Error404();
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    if (!options || !options.bypassPermissionValidation) {
      if (!isUserInTenant(record, currentTenant)) {
        throw new Error404();
      }

      record = this._mapUserForTenant(
        record,
        currentTenant,
      );
    }

    return record;
  }

  static async findByIdWithoutAvatar(
    id,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    let record;
    try {
      record = await options.database.user.findByPk(id, {
        transaction,
      });
    } catch (err: any) {
      const code = err && (err.original && err.original.code) || (err.parent && err.parent.code) || (err && err.code);
      const isBadField = code === 'ER_BAD_FIELD_ERROR';
      if (isBadField && options && options.database && options.database.sequelize) {
        try {
          const rows = await options.database.sequelize.query(
            `SELECT id, fullName, firstName, lastName, password, emailVerified, emailVerificationToken, emailVerificationTokenExpiresAt, provider, providerId, passwordResetToken, passwordResetTokenExpiresAt, phoneNumber, email, jwtTokenInvalidBefore, lastLoginAt, importHash, createdAt, updatedAt, deletedAt, createdById, updatedById FROM users WHERE id = ? LIMIT 1`,
            { replacements: [id], type: options.database.Sequelize.QueryTypes.SELECT },
          );
          if (Array.isArray(rows) && rows.length) {
            const row = rows[0];
            record = {
              id: row.id,
              get: (_o: any) => row,
              getAvatars: async (opts: any) => {
                try {
                  const tableName = options.database.user.getTableName();
                  return options.database.file.findAll({
                    where: {
                      belongsTo: tableName,
                      belongsToId: row.id,
                      belongsToColumn: 'avatars',
                    },
                    transaction: opts && opts.transaction,
                  });
                } catch (e) {
                  return [];
                }
              },
              getTenants: async (opts: any) => {
                try {
                  const TenantUserRepository = require('../repositories/tenantUserRepository').default;
                  const tenants = await TenantUserRepository.findByUser(row.id, { ...options, transaction: opts && opts.transaction });
                  return tenants;
                } catch (e) {
                  return [];
                }
              },
            } as any;
          } else {
            record = null;
          }
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    record = await this._fillWithRelationsAndFiles(
      record,
      options,
    );

    if (!options || !options.bypassPermissionValidation) {
      if (!isUserInTenant(record, currentTenant)) {
        throw new Error404();
      }
    }

    return record;
  }

  static async findByPasswordResetToken(
    token,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const record = await options.database.user.findOne({
      where: {
        passwordResetToken: token,
        // Find only not expired tokens
        passwordResetTokenExpiresAt: {
          [options.database.Sequelize.Op.gt]: Date.now(),
        },
      },
      transaction,
    });

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findByEmailVerificationToken(
    token,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const record = await options.database.user.findOne({
      where: {
        emailVerificationToken: token,
        emailVerificationTokenExpiresAt: {
          [options.database.Sequelize.Op.gt]: Date.now(),
        },
      },
      transaction,
    });

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async markEmailVerified(
    id,
    options: IRepositoryOptions,
  ) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.findByPk(id, {
      transaction,
    });

    await user.update(
      {
        emailVerified: true,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.UPDATE,
        values: {
          id,
          emailVerified: true,
        },
      },
      options,
    );

    // Promote any tenant invitations to active when the user's email is verified
    try {
      const invitedTenantUsers = await options.database.tenantUser.findAll({
        where: { userId: user.id, status: 'invited' },
        transaction,
      });

      for (const invited of invitedTenantUsers) {
        invited.invitationToken = null;
        invited.invitationTokenExpiresAt = null;
        invited.status = 'active';
        await invited.save({ transaction });

        await AuditLogRepository.log(
          {
            entityName: 'user',
            entityId: user.id,
            action: AuditLogRepository.UPDATE,
            values: {
              id: user.id,
              email: user.email,
              roles: invited.roles,
              status: invited.status,
            },
          },
          options,
        );
      }
    } catch (e) {
      // If something goes wrong promoting tenant users, log and continue
      console.error('Error promoting invited tenant users on email verification:', e);
    }

    return true;
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    return options.database.user.count({
      where: filter,
      transaction,
    });
  }

  static async findPassword(
    id,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    try {
      const record = await options.database.user.findByPk(
        id,
        {
          // raw is responsible
          // for bringing the password
          raw: true,
          transaction,
        },
      );

      if (!record) {
        return null;
      }

      return record.password;
    } catch (err: any) {
      const code = err && (err.original && err.original.code) || (err.parent && err.parent.code) || (err && err.code);
      const isBadField = code === 'ER_BAD_FIELD_ERROR';
      if (isBadField && options && options.database && options.database.sequelize) {
        try {
          const rows = await options.database.sequelize.query(
            `SELECT password FROM users WHERE id = ? LIMIT 1`,
            { replacements: [id], type: options.database.Sequelize.QueryTypes.SELECT },
          );
          if (Array.isArray(rows) && rows.length) {
            const row: any = rows[0];
            return row.password || null;
          }
          return null;
        } catch (err2) {
          throw err2;
        }
      }

      throw err;
    }
  }

  static async createFromSocial(
    provider,
    providerId,
    email,
    emailVerified,
    firstName,
    lastName,
    options,
  ) {
    let data = {
      email,
      emailVerified,
      providerId,
      provider,
      firstName,
      lastName,
    };

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const user = await options.database.user.create(data, {
      transaction,
    });

    delete user.password;
    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.CREATE,
        values: {
          ...user.get({ plain: true }),
        },
      },
      options,
    );

    return this.findById(user.id, {
      ...options,
      bypassPermissionValidation: true,
    });
  }

  static cleanupForRelationships(userOrUsers) {
    if (!userOrUsers) {
      return userOrUsers;
    }

    if (Array.isArray(userOrUsers)) {
      return userOrUsers.map((user) =>
        lodash.pick(user, [
          'id',
          'fullName',
          'firstName',
          'lastName',
          'email',
          'phoneNumber',
          'guardNumber',
          'employeeCode',
        ]),
      );
    }

    return lodash.pick(userOrUsers, [
      'id',
      'fullName',
      'firstName',
      'lastName',
      'email',
      'phoneNumber',
      'guardNumber',
      'employeeCode',
    ]);
  }

  static async filterIdInTenant(
    id,
    options: IRepositoryOptions,
  ) {
    return lodash.get(
      await this.filterIdsInTenant([id], options),
      '[0]',
      null,
    );
  }

  static async filterIdsInTenant(
    ids,
    options: IRepositoryOptions,
  ) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant =
      SequelizeRepository.getCurrentTenant(options);

    const where = {
      id: {
        [Op.in]: ids,
      },
    };

    let include = [
      {
        model: options.database.tenantUser,
        as: 'tenants',
        where: {
          ['tenantId']: currentTenant.id,
        },
      },
    ];

    const records = await options.database.user.findAll({
      attributes: ['id'],
      where,
      include,
    });

    return records.map((record) => record.id);
  }

  static async _fillWithRelationsAndFilesForRows(
    rows,
    options: IRepositoryOptions,
  ) {
    if (!rows) {
      return rows;
    }

    return Promise.all(
      rows.map((record) =>
        this._fillWithRelationsAndFiles(record, options),
      ),
    );
  }

  /**
   * LEAN enricher for the office-users LIST path. The `tenants` relation (with
   * tenant{id}, assignedClients{id,name}, assignedPostSites{id,companyName}) is
   * already eager-loaded by findAndCountAll's include, so we just serialize each
   * row to plain — NO per-row getTenants()/getAvatars() round-trips and NO file
   * signing. _mapUserForTenant then reduces this to the consumed shape. The full
   * per-row enrichment (avatars, tenant settings) stays in findById.
   */
  static _fillForList(rows) {
    if (!rows) {
      return rows;
    }
    return rows.map((record) => {
      const output: any = record.get({ plain: true });
      // tenants already populated by the eager include; ensure the key exists.
      output.tenants = output.tenants || [];
      return output;
    });
  }

  static async _fillWithRelationsAndFiles(
    record,
    options: IRepositoryOptions,
  ) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    output.avatars = await FileRepository.fillDownloadUrl(
      await record.getAvatars({
        transaction: SequelizeRepository.getTransaction(
          options,
        ),
      }),
    );

    // Load tenant-user relationships and include assigned clients/post sites.
    // PERF: findById already eager-loads `tenants` with the exact include
    // shape below, so reuse it instead of re-running the same join — this
    // helper runs on EVERY authenticated request (AuthService.findByToken →
    // findById). The JS filter replicates the `required: true` on the tenant
    // include (drops tenantUser rows whose tenant is missing/soft-deleted).
    // Callers that pass records without the association loaded (findByEmail,
    // findByPhone, token lookups, ER_BAD_FIELD fallbacks…) still take the
    // getTenants query below.
    if (Array.isArray(record.tenants)) {
      output.tenants = record.tenants.filter(
        (tenantUser) => tenantUser.tenant,
      );
    } else {
      output.tenants = await record.getTenants({
        include: [
          {
            model: options.database.tenant,
            as: 'tenant',
            required: true,
            include: ['settings'],
          },
          {
            model: options.database.clientAccount,
            as: 'assignedClients',
            attributes: ['id', 'name'],
            through: { attributes: [] },
          },
          {
            model: options.database.businessInfo,
            as: 'assignedPostSites',
            attributes: ['id', 'companyName'],
            through: { attributes: [] },
          },
        ],
        transaction: SequelizeRepository.getTransaction(
          options,
        ),
      });
    }

    return output;
  }

  /**
   * Maps the users data to show only the current tenant related info
   */
  static _mapUserForTenantForRows(rows, tenant) {
    if (!rows) {
      return rows;
    }

    return rows.map((record) =>
      this._mapUserForTenant(record, tenant),
    );
  }

  /**
   * Maps the user data to show only the current tenant related info
   */
  static _mapUserForTenant(user, tenant) {
    if (!user || !user.tenants) {
      return user;
    }

    const tenantUser = user.tenants.find(
      (tenantUser) =>
        tenantUser &&
        tenantUser.tenant &&
        String(tenantUser.tenant.id) === String(tenant.id),
    );

    delete user.tenants;

    const status = tenantUser ? tenantUser.status : null;
    const roles = tenantUser ? tenantUser.roles : [];

    // assigned clients / post sites (if available on the tenantUser relation)
    const assignedClients = (tenantUser && tenantUser.assignedClients)
      ? (tenantUser.assignedClients || []).map((c) => ({ id: c.id, name: c.name }))
      : [];

    const assignedPostSites = (tenantUser && tenantUser.assignedPostSites)
      ? (tenantUser.assignedPostSites || []).map((p) => ({ id: p.id, name: p.companyName || p.name }))
      : [];

    // If the user is only invited, previously we returned only email.
    // Keep invitation flow intact but expose basic name fields so UI can display them.
    const otherData =
      status === 'active'
        ? user
        : {
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
        };

    return {
      ...otherData,
      id: user.id,
      email: user.email,
      roles,
      status,
      assignedClients,
      assignedPostSites,
    };
  }
}
