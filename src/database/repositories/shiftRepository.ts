import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import TenantUserRepository from './tenantUserRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class ShiftRepository {

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

    const record = await options.database.shift.create(
      {
        ...lodash.pick(data, [
          'startTime',
          'endTime',          
          'importHash',
          'postSiteId',
          'tenantUserId',
          'siteTours',
          'tasks',
          'postOrders',
          'checklists',
          'skillSet',
          'department',
        ]),
        stationId: data.station || null,
        guardId: data.guard || null,
        postSiteId: data.postSite || data.postSiteId || null,
        tenantUserId: data.tenantUserId || data.tenant_user_id || null,
        siteTours: data.siteTours || data.site_tours || null,
        tasks: data.tasks || null,
        postOrders: data.postOrders || data.post_orders || null,
        checklists: data.checklists || null,
        skillSet: data.skillSet || data.skill_set || null,
        department: data.department || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    // NOTE: the redundant `stationAssignedGuardsUser` junction write was removed.
    // Assignment membership is now derived from `guardAssignment` / generated
    // shifts (the single source of truth), not from this junction.

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

    let record = await options.database.shift.findOne(      
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
          'startTime',
          'endTime',          
          'importHash',
          'postSiteId',
          'tenantUserId',
          'siteTours',
          'tasks',
          'postOrders',
          'checklists',
          'skillSet',
          'department',
        ]),
        // Presence-guarded: a PARTIAL update (e.g. only startTime) must not
        // null the shift's station/guard/assignment — same antipattern the
        // station repo was fixed for. `field: undefined` is skipped by
        // Sequelize, so absent keys leave the stored value untouched.
        stationId: data.station !== undefined ? (data.station || null) : undefined,
        guardId: data.guard !== undefined ? (data.guard || null) : undefined,
        postSiteId:
          data.postSite !== undefined || data.postSiteId !== undefined
            ? (data.postSite || data.postSiteId || null)
            : undefined,
        tenantUserId:
          data.tenantUserId !== undefined || data.tenant_user_id !== undefined
            ? (data.tenantUserId || data.tenant_user_id || null)
            : undefined,
        siteTours:
          data.siteTours !== undefined || data.site_tours !== undefined
            ? (data.siteTours || data.site_tours || null)
            : undefined,
        tasks: data.tasks !== undefined ? (data.tasks || null) : undefined,
        postOrders:
          data.postOrders !== undefined || data.post_orders !== undefined
            ? (data.postOrders || data.post_orders || null)
            : undefined,
        checklists: data.checklists !== undefined ? (data.checklists || null) : undefined,
        skillSet:
          data.skillSet !== undefined || data.skill_set !== undefined
            ? (data.skillSet || data.skill_set || null)
            : undefined,
        department: data.department !== undefined ? (data.department || null) : undefined,
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

    let record = await options.database.shift.findOne(
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
        model: options.database.station,
        as: 'station',
      },
      {
        model: options.database.user,
        as: 'guard',
      },
      {
        model: options.database.tenantUser,
        as: 'tenantUser',
      },
      {
        model: options.database.tenantUser,
        as: 'tenantUser',
      },      
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.shift.findOne(
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

    const records = await options.database.shift.findAll(
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

    return options.database.shift.count(
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
    // LEAN list path. The shift list (shiftService.ShiftRecord + the post-site /
    // dispatcher consumers) only reads the guard's display fields and the
    // station's {id, stationName}. Scope both includes so the list no longer
    // ships the station geofencePolygon/stationSchedule/nickname TEXT blobs nor
    // the full user row. findById keeps the unscoped includes.
    let include = [
      {
        model: options.database.station,
        as: 'station',
        attributes: ['id', 'stationName'],
      },
      {
        model: options.database.user,
        as: 'guard',
        attributes: ['id', 'fullName', 'firstName', 'lastName', 'email', 'phoneNumber'],
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

      if (filter.startTimeRange) {
        const [start, end] = filter.startTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            startTime: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            startTime: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.endTimeRange) {
        const [start, end] = filter.endTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            endTime: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            endTime: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.station) {
        whereAnd.push({
          ['stationId']: SequelizeFilterUtils.uuid(
            filter.station,
          ),
        });
      }

      if (filter.guard) {
        whereAnd.push({
          ['guardId']: SequelizeFilterUtils.uuid(
            filter.guard,
          ),
        });
      }

      if (filter.openOnly === 'true' || filter.openOnly === true) {
        whereAnd.push({ guardId: null });
      }

      if (filter.postSite) {
        whereAnd.push({
          ['postSiteId']: SequelizeFilterUtils.uuid(filter.postSite),
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
    } = await options.database.shift.findAndCountAll({
      where,
      // Exclude the heavy JSON blobs (siteTours/tasks/postOrders/checklists/
      // skillSet/remindersSent) from the list — they're edit/detail-only and no
      // shift-list consumer reads them. Kept on findById.
      attributes: {
        exclude: ['siteTours', 'tasks', 'postOrders', 'checklists', 'skillSet', 'remindersSent'],
      },
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

    const records = await options.database.shift.findAll(
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
        entityName: 'shift',
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

    output.guard = UserRepository.cleanupForRelationships(output.guard);
    try {
      if (TenantUserRepository && typeof (TenantUserRepository as any).cleanupForRelationships === 'function') {
        output.tenantUser = (TenantUserRepository as any).cleanupForRelationships(output.tenantUser);
      }
    } catch (e) {
      // ignore
    }

    return output;
  }
}

export default ShiftRepository;
