import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';
import FileRepository from './fileRepository';

const Op = Sequelize.Op;

class VehicleRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.vehicle.create(
      {
        ...lodash.pick(data, [
          'name',
          'licensePlate',
          'active',
          'importHash',
          'year',
          'make',
          'model',
          'color',
          'vin',
          'initialMileage',
          'ownership',
          'description',
        ]),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.vehicle.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
      options,
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.vehicle.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        ...lodash.pick(data, [
          'name',
          'licensePlate',
          'active',
          'year',
          'make',
          'model',
          'color',
          'vin',
          'initialMileage',
          'ownership',
          'description',
        ]),
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.vehicle.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
      options,
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.vehicle.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.vehicle.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }
    return this._fillWithRelationsAndFiles(record, options);
  }
  static async findAllAutocomplete(search, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    const where: any = { tenantId: tenant.id };

    if (search) {
      where[Op.or] = [
        SequelizeFilterUtils.ilikeIncludes('vehicle', 'name', search),
        SequelizeFilterUtils.ilikeIncludes('vehicle', 'licensePlate', search),
      ];
    }

    const records = await options.database.vehicle.findAll({
      attributes: ['id', 'name', 'licensePlate'],
      where,
      limit: limit || 10,
      order: [['name', 'ASC']],
    });

    return records.map((r) => ({ id: r.id, label: r.name || r.licensePlate }));
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [];
    whereAnd.push({ tenantId: tenant.id });

    if (filter) {
      if (filter.id) {
        whereAnd.push({ id: SequelizeFilterUtils.uuid(filter.id) });
      }

      if (filter.name) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('vehicle', 'name', filter.name));
      }

      if (filter.licensePlate) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('vehicle', 'licensePlate', filter.licensePlate));
      }

      if (filter.active !== undefined) {
        whereAnd.push({ active: filter.active });
      }
    }

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.vehicle.findAndCountAll({
      where,
      limit: limit === 0 ? undefined : limit,
      offset: offset === 0 ? undefined : offset,
      order: [['name', 'ASC']],
    });

    const filledRows = await this._fillWithRelationsAndFilesForRows(rows, options);

    return { rows: filledRows, count };
  }

  static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
    if (!rows) return rows;
    return Promise.all(rows.map((record) => this._fillWithRelationsAndFiles(record, options)));
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) return record;
    const output = record.get({ plain: true });
    const transaction = SequelizeRepository.getTransaction(options);
    output.imageUrl = await FileRepository.fillDownloadUrl(
      await record.getImageUrl({ transaction }),
    );
    return output;
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    return lodash.get(await this.filterIdsInTenant([id], options), '[0]', null);
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const where = {
      id: { [Op.in]: ids },
      tenantId: currentTenant.id,
    };

    const records = await options.database.vehicle.findAll({ attributes: ['id'], where });

    return records.map((record) => record.id);
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    let values = {};
    if (data) {
      try {
        values = { ...record.get({ plain: true }) };
      } catch (e) {
        values = { id: record.id };
      }
    }

    await AuditLogRepository.log({ entityName: 'vehicle', entityId: record.id, action, values }, options);
  }
}

export default VehicleRepository;
