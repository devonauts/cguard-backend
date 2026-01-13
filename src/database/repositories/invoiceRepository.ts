import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class InvoiceRepository {

  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.invoice.create(
      {
        ...lodash.pick(data, [
          'invoiceNumber',
          'poSoNumber',
          'title',
          'summary',
          'date',
          'dueDate',
          'items',
          'notes',
          'subtotal',
          'total',
          'importHash',
        ]),
        clientId: data.clientId || null,
        postSiteId: data.postSiteId || null,
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

    let record = await options.database.invoice.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        ...lodash.pick(data, [
          'invoiceNumber',
          'poSoNumber',
          'title',
          'summary',
          'date',
          'dueDate',
          'items',
          'notes',
          'subtotal',
          'total',
          'importHash',
        ]),
        clientId: data.clientId || null,
        postSiteId: data.postSiteId || null,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.invoice.findOne({
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

    const include = [
      { model: options.database.clientAccount, as: 'client' },
      { model: options.database.postSite, as: 'postSite' },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.invoice.findOne({
      where: { id, tenantId: currentTenant.id },
      include,
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    return record.get({ plain: true });
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    return lodash.get(await this.filterIdsInTenant([id], options), '[0]', null);
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) return [];
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const where = { id: { [Op.in]: ids }, tenantId: currentTenant.id };
    const records = await options.database.invoice.findAll({ attributes: ['id'], where });
    return records.map((r) => r.id);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    return options.database.invoice.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [];
    let include = [
      { model: options.database.clientAccount, as: 'client' },
      { model: options.database.postSite, as: 'postSite' },
    ];

    whereAnd.push({ tenantId: tenant.id });

    if (filter) {
      if (filter.id) whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      if (filter.invoiceNumber) whereAnd.push(SequelizeFilterUtils.ilikeIncludes('invoice', 'invoiceNumber', filter.invoiceNumber));
      if (filter.clientId) whereAnd.push({ ['clientId']: SequelizeFilterUtils.uuid(filter.clientId) });
      if (filter.postSiteId) whereAnd.push({ ['postSiteId']: SequelizeFilterUtils.uuid(filter.postSiteId) });
      if (filter.totalRange) {
        const [start, end] = filter.totalRange;
        if (start !== undefined && start !== null && start !== '') whereAnd.push({ total: { [Op.gte]: start } });
        if (end !== undefined && end !== null && end !== '') whereAnd.push({ total: { [Op.lte]: end } });
      }
    }

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.invoice.findAndCountAll({
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    return { rows: rows.map((r) => r.get({ plain: true })), count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [{ tenantId: tenant.id }];
    if (query) {
      whereAnd.push({ [Op.or]: [{ ['id']: SequelizeFilterUtils.uuid(query) }, { ['invoiceNumber']: { [Op.iLike]: `%${query}%` } }] });
    }
    const where = { [Op.and]: whereAnd };
    const records = await options.database.invoice.findAll({ attributes: ['id', 'invoiceNumber'], where, limit: limit ? Number(limit) : undefined, order: [['invoiceNumber', 'ASC']] });
    return records.map((record) => ({ id: record.id, label: record.invoiceNumber }));
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    let values = {};
    if (data) {
      values = { ...record.get({ plain: true }) };
    }
    await AuditLogRepository.log({ entityName: 'invoice', entityId: record.id, action, values }, options);
  }
}

export default InvoiceRepository;
