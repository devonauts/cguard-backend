import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import lodash from 'lodash';
import Sequelize from 'sequelize';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';

const Op = Sequelize.Op;

class ClientContactRepository {
  static async create(data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const createData = {
      name: data.name,
      email: data.email || null,
      mobile: data.mobile || null,
      description: data.description || null,
      postSiteId: data.postSiteId || data.postSite || null,
      allowGuard: data.allowGuard || false,
      clientAccountId: data.clientAccountId || null,
      tenantId: tenant.id,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    };

    const record = await options.database.clientContact.create(createData, { transaction });

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.clientContact.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        name: data.name,
        email: data.email || null,
        mobile: data.mobile || null,
        description: data.description || null,
        postSiteId: data.postSiteId || data.postSite || null,
        allowGuard: data.allowGuard || false,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.clientContact.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const include = [
      { model: options.database.clientAccount, as: 'clientAccount' },
      { model: options.database.businessInfo, as: 'postSite' },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const record = await options.database.clientContact.findOne({ where: { id, tenantId: currentTenant.id }, include, transaction });

    if (!record) {
      throw new Error404();
    }

    return record.get({ plain: true });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: any[] = [{ tenantId: tenant.id }];

    if (filter) {
      if (filter.clientAccountId) {
        whereAnd.push({ clientAccountId: SequelizeFilterUtils.uuid(filter.clientAccountId) });
      }
      if (filter.postSiteId) {
        whereAnd.push({ postSiteId: SequelizeFilterUtils.uuid(filter.postSiteId) });
      }
      if (filter.name) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('clientContact', 'name', filter.name));
      }
      if (filter.email) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('clientContact', 'email', filter.email));
      }
    }

    const where = { [Op.and]: whereAnd };

    let { rows, count } = await options.database.clientContact.findAndCountAll({
      where,
      include: [
        { model: options.database.clientAccount, as: 'clientAccount' },
        { model: options.database.businessInfo, as: 'postSite' },
      ],
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    rows = rows.map((r) => r.get({ plain: true }));

    return { rows, count };
  }

  static async _createAuditLog(action, record, data, options) {
    let values = {};
    if (data) {
      values = { ...record.get({ plain: true }) };
    }

    await AuditLogRepository.log({ entityName: 'clientContact', entityId: record.id, action, values }, options);
  }
}

export default ClientContactRepository;
