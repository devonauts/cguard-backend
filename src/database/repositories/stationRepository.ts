import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class StationRepository {

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

    const record = await options.database.station.create(
      {
        ...lodash.pick(data, [
          'stationName',
          'latitud',
          'longitud',
          'numberOfGuardsInStation',
          'stationSchedule',
          'startingTimeInDay',
          'finishTimeInDay',          
          'importHash',
        ]),
        stationOriginId: data.stationOrigin || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    await record.setAssignedGuards(data.assignedGuards || [], {
      transaction,
    });
    await record.setTasks(data.tasks || [], {
      transaction,
    });
    await record.setReports(data.reports || [], {
      transaction,
    });
    await record.setIncidents(data.incidents || [], {
      transaction,
    });
    await record.setCheckpoints(data.checkpoints || [], {
      transaction,
    });
    await record.setPatrol(data.patrol || [], {
      transaction,
    });
    await record.setShift(data.shift || [], {
      transaction,
    });    
  

  
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

    let record = await options.database.station.findOne(      
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
          'stationName',
          'latitud',
          'longitud',
          'numberOfGuardsInStation',
          'stationSchedule',
          'startingTimeInDay',
          'finishTimeInDay',          
          'importHash',
        ]),
        stationOriginId: data.stationOrigin || null,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    await record.setAssignedGuards(data.assignedGuards || [], {
      transaction,
    });
    await record.setTasks(data.tasks || [], {
      transaction,
    });
    await record.setReports(data.reports || [], {
      transaction,
    });
    await record.setIncidents(data.incidents || [], {
      transaction,
    });
    await record.setCheckpoints(data.checkpoints || [], {
      transaction,
    });
    await record.setPatrol(data.patrol || [], {
      transaction,
    });
    await record.setShift(data.shift || [], {
      transaction,
    });



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

    let record = await options.database.station.findOne(
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
        model: options.database.clientAccount,
        as: 'stationOrigin',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.station.findOne(
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

    const records = await options.database.station.findAll(
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

    return options.database.station.count(
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
        model: options.database.clientAccount,
        as: 'stationOrigin',
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

      if (filter.stationOrigin) {
        whereAnd.push({
          ['stationOriginId']: SequelizeFilterUtils.uuid(
            filter.stationOrigin,
          ),
        });
      }

      if (filter.stationName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'stationName',
            filter.stationName,
          ),
        );
      }

      if (filter.stationSchedule) {
        whereAnd.push({
          stationSchedule: filter.stationSchedule,
        });
      }

      if (filter.startingTimeInDay) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'startingTimeInDay',
            filter.startingTimeInDay,
          ),
        );
      }

      if (filter.finishTimeInDay) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'finishTimeInDay',
            filter.finishTimeInDay,
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
    } = await options.database.station.findAndCountAll({
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
          {
            [Op.and]: SequelizeFilterUtils.ilikeIncludes(
              'station',
              'stationName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.station.findAll(
      {
        attributes: ['id', 'stationName'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['stationName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.stationName,
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
        assignedGuardsIds: data.assignedGuards,
        tasksIds: data.tasks,
        reportsIds: data.reports,
        incidentsIds: data.incidents,
        checkpointsIds: data.checkpoints,
        patrolIds: data.patrol,
        shiftIds: data.shift,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'station',
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

    output.assignedGuards = await record.getAssignedGuards({
      transaction,
    });

    output.assignedGuards = UserRepository.cleanupForRelationships(output.assignedGuards);

    output.tasks = await record.getTasks({
      transaction,
    });

    output.reports = await record.getReports({
      transaction,
    });

    output.incidents = await record.getIncidents({
      transaction,
    });

    output.checkpoints = await record.getCheckpoints({
      transaction,
    });

    output.patrol = await record.getPatrol({
      transaction,
    });

    output.shift = await record.getShift({
      transaction,
    });

    return output;
  }
}

export default StationRepository;
