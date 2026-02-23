import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class LicenseTypeRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.licenseType.create(
      {
        ...lodash.pick(data, ['name', 'status', 'importHash']),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.licenseType.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    record = await record.update(
      { ...lodash.pick(data, ['name', 'status', 'importHash']), updatedById: currentUser.id },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.licenseType.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) throw new Error404();

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async destroyAll(ids, options: IRepositoryOptions) {
    for (const id of ids) {
      await this.destroy(id, options);
    }
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.licenseType.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) throw new Error404();
    return record.get({ plain: true });
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    return options.database.licenseType.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [{ tenantId: tenant.id }];

    if (filter) {
      if (filter.id) whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      if (filter.name) whereAnd.push(SequelizeFilterUtils.ilikeIncludes('licenseType', 'name', filter.name));
      if (filter.status) whereAnd.push({ status: filter.status });
      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange;
        if (start) whereAnd.push({ createdAt: { [Op.gte]: start } });
        if (end) whereAnd.push({ createdAt: { [Op.lte]: end } });
      }
    }

    const where = { [Op.and]: whereAnd };

    let { rows, count } = await options.database.licenseType.findAndCountAll({ where, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, order: orderBy ? [orderBy.split('_')] : [['name', 'ASC']], transaction: SequelizeRepository.getTransaction(options) });

    rows = rows.map((r) => r.get({ plain: true }));

    return { rows, count };
  }

  static async findAllAutocomplete(search, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [{ tenantId: tenant.id }];
    if (search) whereAnd.push({ [Op.or]: [{ ['id']: SequelizeFilterUtils.uuid(search) }, { [Op.and]: SequelizeFilterUtils.ilikeIncludes('licenseType', 'name', search) }] });
    const where = { [Op.and]: whereAnd };
    const records = await options.database.licenseType.findAll({ attributes: ['id', 'name'], where, limit: limit ? Number(limit) : undefined, order: [['name', 'ASC']] });
    return records.map((record) => ({ id: record.id, label: record.name }));
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    await AuditLogRepository.log({ entityName: 'licenseType', entityId: record.id, action, values: data ? { ...record.get({ plain: true }) } : {} }, options);
  }
}

export default LicenseTypeRepository;
