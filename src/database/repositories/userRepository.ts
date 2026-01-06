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

    const record = await options.database.user.findOne({
      where: {
        [Op.and]: SequelizeFilterUtils.ilikeExact(
          'user',
          'email',
          email,
        ),
      },
      transaction,
    });

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findByEmailWithoutAvatar(
    email,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const record = await options.database.user.findOne({
      where: {
        [Op.and]: SequelizeFilterUtils.ilikeExact(
          'user',
          'email',
          email,
        ),
      },
      transaction,
    });

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

    // Always include tenantUser relation for the current tenant and eagerly load
    // assignedClients and assignedPostSites so the frontend receives pivot data.
    if (!filter || (!filter.role && !filter.status)) {
      include.push({
        model: options.database.tenantUser,
        as: 'tenants',
        where: {
          ['tenantId']: currentTenant.id,
        },
        include: [
          { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id', 'name'], through: { attributes: [] } },
          { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id', 'companyName'], through: { attributes: [] } },
        ],
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

        include.push({
          model: options.database.tenantUser,
          as: 'tenants',
          where: { [Op.and]: innerWhereAnd },
          include: [
            { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id', 'name'], through: { attributes: [] } },
            { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id', 'companyName'], through: { attributes: [] } },
          ],
        });
      }

      if (filter.status) {
        include.push({
          model: options.database.tenantUser,
          as: 'tenants',
          where: {
            ['tenantId']: currentTenant.id,
            status: filter.status,
          },
          include: [
            { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id', 'name'], through: { attributes: [] } },
            { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id', 'companyName'], through: { attributes: [] } },
          ],
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
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy
        ? [orderBy.split('_')]
        : [['email', 'ASC']],
      transaction,
    });

    rows = await this._fillWithRelationsAndFilesForRows(
      rows,
      options,
    );

    rows = this._mapUserForTenantForRows(
      rows,
      currentTenant,
    );

    return { rows, count };
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

    // Eager-load tenantUser relation with assigned clients and post sites
    let record = await options.database.user.findByPk(id, {
      transaction,
      include: [
        {
          model: options.database.tenantUser,
          as: 'tenants',
          include: [
            { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id', 'name'], through: { attributes: [] } },
            { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id', 'companyName'], through: { attributes: [] } },
            { model: options.database.tenant, as: 'tenant' },
          ],
        },
      ],
    });

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

    let record = await options.database.user.findByPk(id, {
      transaction,
    });

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
          'firstName',
          'lastName',
          'email',
          'phoneNumber',
        ]),
      );
    }

    return lodash.pick(userOrUsers, [
      'id',
      'firstName',
      'lastName',
      'email',
      'phoneNumber',
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

    // Load tenant-user relationships and include assigned clients/post sites
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
