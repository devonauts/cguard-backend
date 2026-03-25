import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class IncidentRepository {

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

    const record = await options.database.incident.create(
      {
        ...lodash.pick(data, [
          'date',
          'dateTime',
          'incidentAt',
          'title',
          'subject',
          'description',
          'content',
          'action',
          'postSiteId',
          'callerName',
          'callerType',
          'status',
          'priority',
          'internalNotes',
          'actionsTaken',
          'location',
          'comments',
          'wasRead',          
          'importHash',
        ]),
        stationIncidentsId: data.stationIncidents || null,
        stationId: data.stationId || null,
        incidentTypeId: data.incidentType || null,
        siteId: data.siteId || null,
        postSiteId: data.postSiteId || null,
        clientId: data.clientId || null,
        guardNameId: data.guardNameId || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    
  
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.incident.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
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

    let record = await options.database.incident.findOne(      
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
          'date',
          'dateTime',
          'incidentAt',
          'title',
          'subject',
          'description',
          'content',
          'action',
          'postSiteId',
          'callerName',
          'callerType',
          'status',
          'priority',
          'internalNotes',
          'actionsTaken',
          'location',
          'comments',
          'wasRead',          
          'importHash',
        ]),
        stationIncidentsId: data.stationIncidents || null,
        stationId: data.stationId || null,
        incidentTypeId: data.incidentType || null,
        siteId: data.siteId || null,
        postSiteId: data.postSiteId || null,
        clientId: data.clientId || null,
        guardNameId: data.guardNameId || null,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );



    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.incident.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
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

    let record = await options.database.incident.findOne(
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
        as: 'stationIncidents',
      },
      {
        model: options.database.incidentType,
        as: 'incidentType',
      },
      {
        model: options.database.clientAccount,
        as: 'client',
      },
      {
        model: options.database.station,
        as: 'station',
      },
      {
        model: options.database.businessInfo,
        as: 'site',
      },
      {
        model: options.database.securityGuard,
        as: 'guardName',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.incident.findOne(
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

    const records = await options.database.incident.findAll(
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

    return options.database.incident.count(
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
        model: options.database.station,
        as: 'stationIncidents',
      },
      {
        model: options.database.incidentType,
        as: 'incidentType',
      },
      {
        model: options.database.clientAccount,
        as: 'client',
      },
      {
        model: options.database.station,
        as: 'station',
      },
      {
        model: options.database.businessInfo,
        as: 'site',
      },
      {
        model: options.database.securityGuard,
        as: 'guardName',
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

      if (filter.dateRange) {
        const [start, end] = filter.dateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            date: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            date: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.title) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'incident',
            'title',
            filter.title,
          ),
        );
      }

      if (filter.description) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'incident',
            'description',
            filter.description,
          ),
        );
      }

      if (
        filter.wasRead === true ||
        filter.wasRead === 'true' ||
        filter.wasRead === false ||
        filter.wasRead === 'false'
      ) {
        whereAnd.push({
          wasRead:
            filter.wasRead === true ||
            filter.wasRead === 'true',
        });
      }

      if (filter.stationIncidents) {
        // Support single station id or an array of station ids
        if (Array.isArray(filter.stationIncidents)) {
          whereAnd.push({
            stationIncidentsId: { [Op.in]: filter.stationIncidents.map((s) => SequelizeFilterUtils.uuid(s)) },
          });
        } else {
          whereAnd.push({
            ['stationIncidentsId']: SequelizeFilterUtils.uuid(
              filter.stationIncidents,
            ),
          });
        }
      }

      if (filter.incidentType) {
        whereAnd.push({
          ['incidentTypeId']: SequelizeFilterUtils.uuid(
            filter.incidentType,
          ),
        });
      }

      if (filter.postSiteId) {
        whereAnd.push({
          ['postSiteId']: SequelizeFilterUtils.uuid(
            filter.postSiteId,
          ),
        });
      }

      if (filter.clientId) {
        whereAnd.push({
          ['clientId']: SequelizeFilterUtils.uuid(
            filter.clientId,
          ),
        });
      }

      if (filter.siteId) {
        whereAnd.push({
          ['siteId']: SequelizeFilterUtils.uuid(
            filter.siteId,
          ),
        });
      }

      if (filter.stationId) {
        whereAnd.push({
          ['stationId']: SequelizeFilterUtils.uuid(
            filter.stationId,
          ),
        });
      }

      if (filter.status) {
        whereAnd.push(SequelizeFilterUtils.ilikeExact('incident', 'status', filter.status));
      }

      if (filter.callerName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('incident', 'callerName', filter.callerName));
      }

      if (filter.priority) {
        whereAnd.push(SequelizeFilterUtils.ilikeExact('incident', 'priority', filter.priority));
      }

      if (filter.subject) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('incident', 'subject', filter.subject));
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
    } = await options.database.incident.findAndCountAll({
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

    const records = await options.database.incident.findAll(
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
        imageUrl: data.imageUrl,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'incident',
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

    output.imageUrl = await FileRepository.fillDownloadUrl(
      await record.getImageUrl({
        transaction,
      }),
    );

    // incidentType relation
    const incidentType = await record.getIncidentType({ transaction });
    output.incidentType = incidentType ? incidentType.get({ plain: true }) : null;

    const client = await record.getClient ? await record.getClient({ transaction }) : null;
    output.client = client ? client.get({ plain: true }) : null;

    const site = await record.getSite ? await record.getSite({ transaction }) : null;
    output.site = site ? site.get({ plain: true }) : null;

    const station = await record.getStation ? await record.getStation({ transaction }) : null;
    output.station = station ? station.get({ plain: true }) : null;

    const guardName = await record.getGuardName ? await record.getGuardName({ transaction }) : null;
    output.guardName = guardName ? guardName.get({ plain: true }) : null;

    return output;
  }
}

export default IncidentRepository;
