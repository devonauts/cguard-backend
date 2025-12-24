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

    record = await record.update(
      {
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
        guardId: data.guard || null,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

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
        whereAnd.push({
          ['id']: SequelizeFilterUtils.uuid(filter.id),
        });
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
        whereAnd.push({
          ['guardId']: SequelizeFilterUtils.uuid(
            filter.guard,
          ),
        });
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

      // Server-side filter by guard status (e.g. 'active', 'invited', 'pending', 'archived')
      if (filter.status) {
        // Normalize common frontend aliases
        let statuses = [];
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
        attributes: ['id', 'fullName'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['fullName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.fullName,
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
