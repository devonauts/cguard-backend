import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class VisitorLogRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const toCreate = {
      ...lodash.pick(data, [
        'visitDate',
        'lastName',
        'firstName',
        'idNumber',
        'reason',
        'exitTime',
        'numPeople',
        'importHash',
        'clientId',
        'postSiteId',
      ]),
    };

    // Normalize empty exitTime to null
    if (!toCreate.exitTime) {
      toCreate.exitTime = null;
    }

    const record = await options.database.visitorLog.create(
      {
        ...toCreate,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'idPhoto',
        belongsToId: record.id,
      },
      data.idPhoto,
      { ...options, transaction },
    );

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.visitorLog.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const toUpdate = {
      ...lodash.pick(data, [
        'visitDate',
        'lastName',
        'firstName',
        'idNumber',
        'reason',
        'exitTime',
        'numPeople',
        'importHash',
        'clientId',
        'postSiteId',
      ]),
    };

    // Normalize empty exitTime to null
    if (toUpdate.exitTime === '' || toUpdate.exitTime === undefined) {
      toUpdate.exitTime = null;
    }

    record = await record.update(
      {
        ...toUpdate,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'idPhoto',
        belongsToId: record.id,
      },
      data.idPhoto,
      { ...options, transaction },
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.visitorLog.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);

    const include = [];

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.visitorLog.findOne({
      where: { id, tenantId: currentTenant.id },
      include,
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    return lodash.get(await this.filterIdsInTenant([id], options), '[0]', null);
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const where = { id: { [Op.in]: ids }, tenantId: currentTenant.id };

    const records = await options.database.visitorLog.findAll({ attributes: ['id'], where });

    return records.map((record) => record.id);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    return options.database.visitorLog.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [];
    let include = [];

    whereAnd.push({ tenantId: tenant.id });

    if (filter) {
      if (filter.id) {
        whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      }

      if (filter.idNumber) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'idNumber', filter.idNumber));
      }

      if (filter.lastName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'lastName', filter.lastName));
      }

      if (filter.firstName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'firstName', filter.firstName));
      }

      if (filter.visitDateRange) {
        const [start, end] = filter.visitDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({ visitDate: { [Op.gte]: start } });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({ visitDate: { [Op.lte]: end } });
        }
      }
      
      if (filter.exitTimeRange) {
        const [start, end] = filter.exitTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({ exitTime: { [Op.gte]: start } });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({ exitTime: { [Op.lte]: end } });
        }
      }
    }

    const where = { [Op.and]: whereAnd };

    let { rows, count } = await options.database.visitorLog.findAndCountAll({
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    rows = await this._fillWithRelationsAndFilesForRows(rows, options);

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [{ tenantId: tenant.id }];

    if (query) {
      whereAnd.push({ [Op.or]: [{ ['id']: SequelizeFilterUtils.uuid(query) }] });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.visitorLog.findAll({
      attributes: ['id', 'id'],
      where,
      limit: limit ? Number(limit) : undefined,
      order: [['id', 'ASC']],
    });

    return records.map((record) => ({ id: record.id, label: record.id }));
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    let values = {};

    if (data) {
      values = { ...record.get({ plain: true }) };
    }

    await AuditLogRepository.log({ entityName: 'visitorLog', entityId: record.id, action, values }, options);
  }

  static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
    if (!rows) return rows;

    return Promise.all(rows.map((record) => this._fillWithRelationsAndFiles(record, options)));
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) return record;

    const output = record.get({ plain: true });

    // Attach files for idPhoto
    const files = await options.database.file.findAll({
      where: {
        belongsTo: 'visitorLog',
        belongsToId: record.id,
        belongsToColumn: 'idPhoto',
      },
    });

    output.idPhoto = await FileRepository.fillDownloadUrl(files);

    // Attach client information if present
    if (output.clientId) {
      try {
        const client = await options.database.clientAccount.findByPk(
          output.clientId,
        );
        output.client = client ? client.get({ plain: true }) : null;
      } catch (err) {
        output.client = null;
      }
    }

    // Attach postSite information if present
    if (output.postSiteId) {
      try {
        const postSite = await options.database.businessInfo.findByPk(
          output.postSiteId,
        );
        output.postSite = postSite ? postSite.get({ plain: true }) : null;
      } catch (err) {
        output.postSite = null;
      }
    }

    return output;
  }
}

export default VisitorLogRepository;
