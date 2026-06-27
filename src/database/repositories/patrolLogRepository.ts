import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class PatrolLogRepository {

  // Resolve the set of stationIds a non-admin customer is allowed to see, or
  // `null` when the current user is an admin (no station restriction). A
  // patrolLog row has no station column of its own — it has `patrolId` (FK to
  // patrol) and `scannedById` — so customer scoping is applied through the
  // PARENT patrol's `stationId`. Mirrors reportRepository._resolveAllowedStationIds.
  static async _resolveAllowedStationIds(options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const currentUser = SequelizeRepository.getCurrentUser(options);
    if (!currentUser) {
      return null;
    }

    // Admins are unrestricted.
    let isAdmin = false;
    if (currentUser.tenants) {
      const tenantUserRec = currentUser.tenants.find(
        (t) => t.tenant && t.tenant.id === currentTenant.id && t.status === 'active',
      );
      if (tenantUserRec) {
        let roles: any = [];
        if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
        else if (typeof tenantUserRec.roles === 'string') {
          try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
        }
        isAdmin = roles.includes(
          (await import('../../security/roles')).default.values.admin,
        );
      }
    }
    if (isAdmin) {
      return null;
    }

    // Resolve the customer's clientAccountId. Per-request auth may not carry it
    // on currentUser (only sign-in sets it), so fall back to the user link.
    let clientAccountId = (currentUser as any).clientAccountId;
    if (!clientAccountId) {
      const ca = await options.database.clientAccount.findOne({
        where: { userId: currentUser.id, tenantId: currentTenant.id },
        attributes: ['id'],
        transaction,
      });
      clientAccountId = ca && ca.id;
    }

    // Also honour any explicit tenantUser assignedPostSites / assignedClients.
    let allowedPostSiteIds: string[] = [];
    let allowedClientIds: string[] = [];
    try {
      const tenantUser = await options.database.tenantUser.findOne({
        where: { tenantId: currentTenant.id, userId: currentUser.id },
        include: [
          { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] },
          { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] },
        ],
        transaction,
      });
      allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];
      allowedClientIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];
    } catch (e) {
      // ignore — fall back to clientAccount resolution below
    }

    if (clientAccountId && !allowedClientIds.includes(clientAccountId)) {
      allowedClientIds.push(clientAccountId);
    }

    if (!allowedPostSiteIds.length && allowedClientIds.length) {
      const posts = await options.database.businessInfo.findAll({
        where: { tenantId: currentTenant.id, clientAccountId: { [Op.in]: allowedClientIds } },
        attributes: ['id'],
        transaction,
      });
      allowedPostSiteIds = (posts || []).map((p) => p.id).filter(Boolean);
    }

    // Collect stations the customer owns: by postSite OR by direct stationOriginId.
    const stationOr: any[] = [];
    if (allowedPostSiteIds.length) stationOr.push({ postSiteId: { [Op.in]: allowedPostSiteIds } });
    if (allowedClientIds.length) stationOr.push({ stationOriginId: { [Op.in]: allowedClientIds } });

    if (!stationOr.length) {
      return [];
    }

    const stations = await options.database.station.findAll({
      where: { tenantId: currentTenant.id, [Op.or]: stationOr },
      attributes: ['id'],
      transaction,
    });

    return (stations || []).map((s) => s.id).filter(Boolean);
  }

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

    const record = await options.database.patrolLog.create(
      {
        ...lodash.pick(data, [
          'scanTime',
          'latitude',
          'longitude',
          'validLocation',
          'status',          
          'importHash',
        ]),
        patrolId: data.patrol || null,
        scannedById: data.scannedBy || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
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

    let record = await options.database.patrolLog.findOne(      
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
          'scanTime',
          'latitude',
          'longitude',
          'validLocation',
          'status',          
          'importHash',
        ]),
        patrolId: data.patrol || null,
        scannedById: data.scannedBy || null,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
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

    let record = await options.database.patrolLog.findOne(
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

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const include = [
      {
        model: options.database.patrol,
        as: 'patrol',
      },
      {
        model: options.database.user,
        as: 'scannedBy',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.patrolLog.findOne(
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
      throw new Error404();
    }

    // Customer scoping: a non-admin customer may only open a patrolLog whose
    // PARENT patrol belongs to one of their stations. Without this the
    // tenant-only `where` above lets a customer fetch ANY patrolLog by id.
    const allowedStationIds = await this._resolveAllowedStationIds(options);
    if (allowedStationIds !== null) {
      const plain = record.get({ plain: true });
      const stationId = plain.patrol && plain.patrol.stationId;
      if (!stationId || !allowedStationIds.includes(stationId)) {
        throw new Error404();
      }
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

    const records = await options.database.patrolLog.findAll(
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

    return options.database.patrolLog.count(
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

    // Customer scoping: restrict a non-admin customer to patrolLogs whose PARENT
    // patrol belongs to one of their stations. `null` => admin (unrestricted);
    // `[]` => no accessible stations. patrolLog has no station column of its own,
    // so we filter via the joined `patrol` association (required: true makes the
    // join filter rows out without changing the returned row shape).
    const allowedStationIds = await this._resolveAllowedStationIds(options);
    if (allowedStationIds !== null && !allowedStationIds.length) {
      return { rows: [], count: 0 };
    }

    let include = [
      {
        model: options.database.patrol,
        as: 'patrol',
        ...(allowedStationIds !== null
          ? {
              where: { stationId: { [Op.in]: allowedStationIds } },
              required: true,
            }
          : {}),
      },
      {
        model: options.database.user,
        as: 'scannedBy',
      },
    ];

    whereAnd.push({
      tenantId: tenant.id,
    });

    if (filter) {
      if (filter.id) {
        whereAnd.push({
          ['id']: SequelizeFilterUtils.uuid(filter.id),
        });
      }

      if (filter.patrol) {
        whereAnd.push({
          ['patrolId']: SequelizeFilterUtils.uuid(
            filter.patrol,
          ),
        });
      }

      if (filter.scannedBy) {
        whereAnd.push({
          ['scannedById']: SequelizeFilterUtils.uuid(
            filter.scannedBy,
          ),
        });
      }

      if (filter.scanTimeRange) {
        const [start, end] = filter.scanTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            scanTime: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            scanTime: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.latitude) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'patrolLog',
            'latitude',
            filter.latitude,
          ),
        );
      }

      if (filter.longitude) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'patrolLog',
            'longitude',
            filter.longitude,
          ),
        );
      }

      if (
        filter.validLocation === true ||
        filter.validLocation === 'true' ||
        filter.validLocation === false ||
        filter.validLocation === 'false'
      ) {
        whereAnd.push({
          validLocation:
            filter.validLocation === true ||
            filter.validLocation === 'true',
        });
      }

      if (filter.status) {
        whereAnd.push({
          status: filter.status,
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
    } = await options.database.patrolLog.findAndCountAll({
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

        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.patrolLog.findAll(
      {
        attributes: ['id', 'id'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['id', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.id,
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

      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'patrolLog',
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

    output.scannedBy = UserRepository.cleanupForRelationships(output.scannedBy);

    return output;
  }
}

export default PatrolLogRepository;
