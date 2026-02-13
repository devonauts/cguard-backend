import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class SecurityGuardRepository {

  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // If caller marked this as a draft (partial) creation flow, fill required DB fields
    // with safe placeholders to avoid NOT NULL DB errors. These must be updated later.
    let createPayload: any = lodash.pick(data, [
      'governmentId',
      'fullName',
      'hiringContractDate',
      'gender',
      'isOnDuty',
      'bloodType',
      'guardCredentials',
      'birthDate',
      'birthPlace',
      'maritalStatus',
      'academicInstruction',
      'address',          
      'importHash',
    ]);

    createPayload.guardId = data.guard || null;
    createPayload.tenantId = tenant.id;
    createPayload.createdById = currentUser.id;
    createPayload.updatedById = currentUser.id;

    if (data && data.isDraft) {
      // Ensure guardId exists (required FK)
      if (!createPayload.guardId) {
        throw new Error('Draft securityGuard requires a valid guard id');
      }

      // Try to fetch user to build sensible defaults
      try {
        const guardUser = await options.database.user.findByPk(createPayload.guardId, { transaction });
        const userFullName = guardUser
          ? (guardUser.fullName || [guardUser.firstName, guardUser.lastName].filter(Boolean).join(' '))
          : null;

        // Prefer any name sent in the incoming payload (e.g. firstName/lastName or fullName)
        const incomingFullName = data.fullName || ((data.firstName || data.lastName)
          ? [data.firstName, data.lastName].filter(Boolean).join(' ')
          : null);

        // governmentId has max length 20 in the model; use a short placeholder when not provided
        createPayload.governmentId = createPayload.governmentId || 'PENDING';
        createPayload.fullName = createPayload.fullName || incomingFullName || userFullName || 'PENDING NAME';
        createPayload.gender = createPayload.gender || 'Masculino';
        createPayload.bloodType = createPayload.bloodType || 'O+';
        createPayload.birthDate = createPayload.birthDate || new Date('1970-01-01');
        createPayload.maritalStatus = createPayload.maritalStatus || 'Soltero';
        createPayload.academicInstruction = createPayload.academicInstruction || 'Secundaria';
      } catch (err) {
        // If something goes wrong getting the user, rethrow a clearer error
        const message =
          err instanceof Error ? err.message : String(err);
        throw new Error('Error preparing draft security guard: ' + message);
      }
    }

    const record = await options.database.securityGuard.create(
      createPayload,
      {
        transaction,
      },
    );

    await record.setMemos(data.memos || [], {
      transaction,
    });
    await record.setRequests(data.requests || [], {
      transaction,
    });
    await record.setTutoriales(data.tutoriales || [], {
      transaction,
    });    
  
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'profileImage',
        belongsToId: record.id,
      },
      data.profileImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'credentialImage',
        belongsToId: record.id,
      },
      data.credentialImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'recordPolicial',
        belongsToId: record.id,
      },
      data.recordPolicial,
      options,
    );
  
    await this._createAuditLog(
      AuditLogRepository.CREATE,
      record,
      data,
      options,
    );

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );


    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.securityGuard.findOne(      
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    // Build an update payload and only include guardId when explicitly provided
    const payloadToUpdate: any = {
      ...lodash.pick(data, [
        'governmentId',
        'fullName',
        'hiringContractDate',
        'gender',
        'isOnDuty',
        'bloodType',
        'guardCredentials',
        'birthDate',
        'birthPlace',
        'maritalStatus',
        'academicInstruction',
        'address',          
        'importHash',
      ]),
      updatedById: currentUser.id,
    };

    if (Object.prototype.hasOwnProperty.call(data, 'guard')) {
      // Only set guardId when the caller explicitly provided `guard` in payload
      // and the provided value is not null/undefined. This avoids overwriting
      // the existing FK with null when the caller meant to leave it unchanged.
      if (data.guard !== null && typeof data.guard !== 'undefined') {
        payloadToUpdate.guardId = data.guard;
      } else {
        console.warn('securityGuardRepository.update: received explicit guard=null/undefined; skipping guardId update to avoid NOT NULL violation');
      }
    }

    record = await record.update(payloadToUpdate, { transaction });

    // If updating a draft, allow keeping placeholders when data.isDraft === true
    if (data && data.isDraft) {
      // Ensure guardId exists
      if (!data.guard && !record.guardId) {
        throw new Error('Draft securityGuard update requires a valid guard id');
      }
    }

    await record.setMemos(data.memos || [], {
      transaction,
    });
    await record.setRequests(data.requests || [], {
      transaction,
    });
    await record.setTutoriales(data.tutoriales || [], {
      transaction,
    });

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'profileImage',
        belongsToId: record.id,
      },
      data.profileImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'credentialImage',
        belongsToId: record.id,
      },
      data.credentialImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'recordPolicial',
        belongsToId: record.id,
      },
      data.recordPolicial,
      options,
    );

    await this._createAuditLog(
      AuditLogRepository.UPDATE,
      record,
      data,
      options,
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    await record.destroy({
      transaction,
    });

    await this._createAuditLog(
      AuditLogRepository.DELETE,
      record,
      record,
      options,
    );
  }

  static async restore(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    // find the record including soft-deleted ones
    let record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        paranoid: false,
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    // restore the record (Sequelize instance method)
    await record.restore({ transaction });

    await this._createAuditLog(
      AuditLogRepository.UPDATE,
      record,
      record,
      options,
    );
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const include = [
      {
        model: options.database.user,
        as: 'guard',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        include,
        transaction,
      },
    );

    if (!record) {
      // Use custom error message for not found guard
      const language = options && options.language ? options.language : 'es';
      throw new Error404(language, 'entities.securityGuard.errors.notFound');
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  // Partial update that only touches fields/relations provided in `data`.
  static async patchUpdate(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.securityGuard.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const allowed = [
      'governmentId',
      'fullName',
      'hiringContractDate',
      'gender',
      'isOnDuty',
      'bloodType',
      'guardCredentials',
      'birthDate',
      'birthPlace',
      'maritalStatus',
      'academicInstruction',
      'address',
      'importHash',
    ];

    const updatePayload: any = {};
    allowed.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        updatePayload[k] = data[k];
      }
    });

    if (Object.prototype.hasOwnProperty.call(data, 'guard')) {
      updatePayload.guardId = data.guard || null;
    }

    // Always set updatedById
    updatePayload.updatedById = currentUser.id;

    // Apply only provided scalar fields
    if (Object.keys(updatePayload).length) {
      record = await record.update(updatePayload, { transaction });
    }

    // Only update associations/files if present in the payload
    if (Object.prototype.hasOwnProperty.call(data, 'memos')) {
      await record.setMemos(data.memos || [], { transaction });
    }
    if (Object.prototype.hasOwnProperty.call(data, 'requests')) {
      await record.setRequests(data.requests || [], { transaction });
    }
    if (Object.prototype.hasOwnProperty.call(data, 'tutoriales')) {
      await record.setTutoriales(data.tutoriales || [], { transaction });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'profileImage')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'profileImage',
          belongsToId: record.id,
        },
        data.profileImage,
        options,
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, 'credentialImage')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'credentialImage',
          belongsToId: record.id,
        },
        data.credentialImage,
        options,
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, 'recordPolicial')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'recordPolicial',
          belongsToId: record.id,
        },
        data.recordPolicial,
        options,
      );
    }

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
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
      tenantId: currentTenant.id,
    };

    const records = await options.database.securityGuard.findAll(
      {
        attributes: ['id'],
        where,
      },
    );

    return records.map((record) => record.id);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    return options.database.securityGuard.count(
      {
        where: {
          ...filter,
          tenantId: tenant.id,
        },
        transaction,
      },
    );
  }

  static async findAndCountAll(
    { filter, limit = 0, offset = 0, orderBy = '' },
    options: IRepositoryOptions,
  ) {
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [];
    let include = [
      {
        model: options.database.user,
        as: 'guard',
      },      
    ];

    // By default Sequelize `paranoid` excludes soft-deleted rows.
    // Allow returning archived (soft-deleted) records when requested.
    let includeDeleted = false;

    whereAnd.push({
      tenantId: tenant.id,
    });

    if (filter) {
      if (filter.id) {
        // Support single id or array of ids
        if (Array.isArray(filter.id)) {
          whereAnd.push({
            id: { [Op.in]: filter.id.map((i) => SequelizeFilterUtils.uuid(i)) },
          });
        } else {
          whereAnd.push({
            ['id']: SequelizeFilterUtils.uuid(filter.id),
          });
        }
      }

      if (filter.governmentId) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'governmentId',
            filter.governmentId,
          ),
        );
      }

      if (filter.fullName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'fullName',
            filter.fullName,
          ),
        );
      }

      if (filter.guard) {
        // Support single id or array of ids
        if (Array.isArray(filter.guard)) {
          whereAnd.push({
            guardId: { [Op.in]: filter.guard.map((g) => SequelizeFilterUtils.uuid(g)) },
          });
        } else {
          whereAnd.push({
            ['guardId']: SequelizeFilterUtils.uuid(
              filter.guard,
            ),
          });
        }
      }

      // Support explicit request to include archived/deleted records
      if (
        filter.archived === true ||
        filter.archived === 'true' ||
        filter.deleted === true ||
        filter.deleted === 'true' ||
        filter.includeDeleted === true ||
        filter.includeDeleted === 'true'
      ) {
        includeDeleted = true;
      }

      // If caller asked for archived records, treat archive as either:
      // - a soft-deleted `securityGuard` row (deletedAt IS NOT NULL), or
      // - a `tenantUser` entry with status = 'archived' (archive via tenant-user pivot).
      if (
        filter.archived === true ||
        filter.archived === 'true' ||
        filter.deleted === true ||
        filter.deleted === 'true'
      ) {
        // Ensure we include soft-deleted rows in the result set
        includeDeleted = true;

        // Find tenantUser entries with status 'archived' for this tenant
        const tenantUsersArchived = await options.database.tenantUser.findAll({
          attributes: ['userId'],
          where: {
            tenantId: tenant.id,
            status: 'archived',
          },
          transaction: SequelizeRepository.getTransaction(options),
        });

        const archivedUserIds = (tenantUsersArchived || []).map((t) => t.userId).filter(Boolean);

        // If we have archived tenant users, include securityGuard records whose guardId
        // references one of those users. Also include any soft-deleted securityGuard rows.
        if (archivedUserIds.length) {
          whereAnd.push({
            [Op.or]: [
              { deletedAt: { [Op.not]: null } },
              { guardId: { [Op.in]: archivedUserIds } },
            ],
          });
        } else {
          // No tenantUsers marked archived; fall back to returning only soft-deleted rows
          whereAnd.push({ deletedAt: { [Op.not]: null } });
        }
      }

      // Server-side filter by guard status (e.g. 'active', 'invited', 'pending', 'archived')
      if (filter.status) {
        // Normalize common frontend aliases
        let statuses: string[] = [];
        if (typeof filter.status === 'string' && filter.status.includes(',')) {
          statuses = filter.status.split(',').map((s) => s.trim());
        } else if (Array.isArray(filter.status)) {
          statuses = filter.status;
        } else {
          statuses = [String(filter.status)];
        }

        // Map aliases
        statuses = statuses.map((s) => {
          if (!s) return s;
          const lower = s.toLowerCase();
          if (lower === 'pending') return 'pending';
          if (lower === 'todos' || lower === 'all' || lower === 'any') return 'ALL';
          return lower;
        });

        // Normalize common synonyms: treat 'pending' and 'invited' as equivalent
        // so frontend options that map to either will return the same results.
        if (statuses.includes('pending') && !statuses.includes('invited')) {
          statuses.push('invited');
        }
        if (statuses.includes('invited') && !statuses.includes('pending')) {
          statuses.push('pending');
        }
        // Ensure uniqueness
        statuses = Array.from(new Set(statuses));

        // If any requested 'archived', include deleted rows
        if (statuses.includes('archived')) {
          includeDeleted = true;
        }

        // If request wanted all statuses, skip filtering by tenantUser.status
        if (statuses.includes('ALL')) {
          // no-op: don't filter by tenantUser
        } else {
          // Find tenantUser entries matching the tenant and any of the statuses
          const whereTenantUser = {
            tenantId: tenant.id,
            status: { [Op.in]: statuses },
          };

          const tenantUsers = await options.database.tenantUser.findAll({
            attributes: ['userId'],
            where: whereTenantUser,
            transaction: SequelizeRepository.getTransaction(options),
          });

          const userIds = tenantUsers.map((t) => t.userId).filter(Boolean);

          // If no users match the status, return empty result set early
          if (!userIds.length) {
            return { rows: [], count: 0 };
          }

          whereAnd.push({
            guardId: {
              [Op.in]: userIds,
            },
          });
        }
      }

      if (filter.hiringContractDateRange) {
        const [start, end] = filter.hiringContractDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            hiringContractDate: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            hiringContractDate: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.gender) {
        whereAnd.push({
          gender: filter.gender,
        });
      }

      if (
        filter.isOnDuty === true ||
        filter.isOnDuty === 'true' ||
        filter.isOnDuty === false ||
        filter.isOnDuty === 'false'
      ) {
        whereAnd.push({
          isOnDuty:
            filter.isOnDuty === true ||
            filter.isOnDuty === 'true',
        });
      }

      if (filter.bloodType) {
        whereAnd.push({
          bloodType: filter.bloodType,
        });
      }

      if (filter.guardCredentials) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'guardCredentials',
            filter.guardCredentials,
          ),
        );
      }

      if (filter.birthDateRange) {
        const [start, end] = filter.birthDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            birthDate: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            birthDate: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.birthPlace) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'birthPlace',
            filter.birthPlace,
          ),
        );
      }

      if (filter.maritalStatus) {
        whereAnd.push({
          maritalStatus: filter.maritalStatus,
        });
      }

      if (filter.academicInstruction) {
        whereAnd.push({
          academicInstruction: filter.academicInstruction,
        });
      }

      if (filter.address) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'address',
            filter.address,
          ),
        );
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
    } = await options.database.securityGuard.findAndCountAll({
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy
        ? [orderBy.split('_')]
        : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(
        options,
      ),
      // When includeDeleted is true, set paranoid:false to include soft-deleted rows
      paranoid: includeDeleted ? false : undefined,
    });

    rows = await this._fillWithRelationsAndFilesForRows(
      rows,
      options,
    );

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [{
      tenantId: tenant.id,
    }];

    // Only return guards whose tenantUser.status is 'active'
    try {
      const activeTenantUsers = await options.database.tenantUser.findAll({
        attributes: ['userId'],
        where: { tenantId: tenant.id, status: 'active' },
        transaction: SequelizeRepository.getTransaction(options),
      });

      const activeUserIds = (activeTenantUsers || []).map((t) => t.userId).filter(Boolean);
      if (!activeUserIds.length) {
        return [];
      }

      // Filter securityGuard.guardId to only those users
      whereAnd.push({
        guardId: { [Op.in]: activeUserIds },
      });
    } catch (e) {
      // If tenantUser lookup fails, fall back to no extra filter (safe default)
      console.warn('securityGuardRepository.findAllAutocomplete: failed to filter by active tenant users', e && (e as any).message ? (e as any).message : e);
    }

    if (query) {
      whereAnd.push({
        [Op.or]: [
          { ['id']: SequelizeFilterUtils.uuid(query) },
          {
            [Op.and]: SequelizeFilterUtils.ilikeIncludes(
              'securityGuard',
              'fullName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.securityGuard.findAll(
      {
        // Include guardId so callers can dedupe results by the underlying user id
        attributes: ['id', 'fullName', 'guardId'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['fullName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.fullName,
      guardId: record.guardId,
    }));
  }

  static async _createAuditLog(
    action,
    record,
    data,
    options: IRepositoryOptions,
  ) {
    let values = {};

    if (data) {
      values = {
        ...record.get({ plain: true }),
        profileImage: data.profileImage,
        credentialImage: data.credentialImage,
        recordPolicial: data.recordPolicial,
        memosIds: data.memos,
        requestsIds: data.requests,
        tutorialesIds: data.tutoriales,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'securityGuard',
        entityId: record.id,
        action,
        values,
      },
      options,
    );
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

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    const transaction = SequelizeRepository.getTransaction(
      options,
    );


    // Buscar status en tenantUser usando userId (guardId)
    let guardUserId = null;
    if (output.guard && output.guard.id) {
      guardUserId = output.guard.id;
    } else if (output.guardId) {
      guardUserId = output.guardId;
    }
    if (guardUserId && output.tenantId) {
      const tenantUser = await options.database.tenantUser.findOne({
        where: {
          tenantId: output.tenantId,
          userId: guardUserId,
        },
      });
      const guardObj = UserRepository.cleanupForRelationships(output.guard);
      output.guard = {
        ...guardObj,
        status: tenantUser ? tenantUser.status : null,
      };
    } else {
      output.guard = UserRepository.cleanupForRelationships(output.guard);
    }

    // Add explicit archived boolean for convenience (soft-deleted records)
    output.archived = Boolean(output.deletedAt);

    // Add top-level status for easier frontend filtering. Prefer 'archived' when soft-deleted.
    output.status = output.guard && output.guard.status ? output.guard.status : null;
    if (output.archived) {
      output.status = 'archived';
    }

    // Expose phoneNumber at top-level so frontend can choose email or phone invites
    // (phoneNumber is stored on the related `guard` user record).
    output.phoneNumber = output.guard && output.guard.phoneNumber ? output.guard.phoneNumber : null;

    output.profileImage = await FileRepository.fillDownloadUrl(
      await record.getProfileImage({
        transaction,
      }),
    );

    output.credentialImage = await FileRepository.fillDownloadUrl(
      await record.getCredentialImage({
        transaction,
      }),
    );

    output.recordPolicial = await FileRepository.fillDownloadUrl(
      await record.getRecordPolicial({
        transaction,
      }),
    );

    output.memos = await record.getMemos({
      transaction,
    });

    output.requests = await record.getRequests({
      transaction,
    });

    output.tutoriales = await record.getTutoriales({
      transaction,
    });

    return output;
  }
}

export default SecurityGuardRepository;
