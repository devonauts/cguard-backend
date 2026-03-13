import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import FileRepository from './fileRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class GuardLicenseRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.guardLicense.create(
      {
        ...lodash.pick(data, ['guardId', 'licenseTypeId', 'customName', 'number', 'issueDate', 'expiryDate', 'importHash']),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    // Attach files
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.guardLicense.getTableName(),
        belongsToColumn: 'frontImage',
        belongsToId: record.id,
      },
      data.frontImage,
      options,
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.guardLicense.getTableName(),
        belongsToColumn: 'backImage',
        belongsToId: record.id,
      },
      data.backImage,
      options,
    );

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.guardLicense.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    record = await record.update(
      { ...lodash.pick(data, ['licenseTypeId', 'customName', 'number', 'issueDate', 'expiryDate', 'importHash']), updatedById: currentUser.id },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.guardLicense.getTableName(),
        belongsToColumn: 'frontImage',
        belongsToId: record.id,
      },
      data.frontImage,
      options,
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.guardLicense.getTableName(),
        belongsToColumn: 'backImage',
        belongsToId: record.id,
      },
      data.backImage,
      options,
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.guardLicense.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
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

    const record = await options.database.guardLicense.findOne({ where: { id, tenantId: currentTenant.id }, include: [{ model: options.database.licenseType, as: 'licenseType' }, { model: options.database.user, as: 'createdBy' }], transaction });
    if (!record) throw new Error404();

    const output = record.get({ plain: true });

    // Attach files download URLs
    output.frontImage = await FileRepository.fillDownloadUrl(await record.getFrontImage({ transaction }));
    output.backImage = await FileRepository.fillDownloadUrl(await record.getBackImage({ transaction }));

    return output;
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [{ tenantId: tenant.id }];

    if (filter) {
      if (filter.id) whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      if (filter.guardId) whereAnd.push({ guardId: SequelizeFilterUtils.uuid(filter.guardId) });
      if (filter.licenseTypeId) whereAnd.push({ licenseTypeId: SequelizeFilterUtils.uuid(filter.licenseTypeId) });
      if (filter.number) whereAnd.push(SequelizeFilterUtils.ilikeIncludes('guardLicense', 'number', filter.number));
      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange;
        if (start) whereAnd.push({ createdAt: { [Op.gte]: start } });
        if (end) whereAnd.push({ createdAt: { [Op.lte]: end } });
      }
    }

    const where = { [Op.and]: whereAnd };

    let { rows, count } = await options.database.guardLicense.findAndCountAll({ where, include: [{ model: options.database.licenseType, as: 'licenseType' }, { model: options.database.user, as: 'createdBy' }], limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']], transaction: SequelizeRepository.getTransaction(options) });

    rows = rows.map((r) => r.get({ plain: true }));

    // Fill file URLs
    for (const r of rows) {
      r.frontImage = await FileRepository.fillDownloadUrl(await options.database.guardLicense.findByPk(r.id).then(x => x.getFrontImage({ transaction: SequelizeRepository.getTransaction(options) })));
      r.backImage = await FileRepository.fillDownloadUrl(await options.database.guardLicense.findByPk(r.id).then(x => x.getBackImage({ transaction: SequelizeRepository.getTransaction(options) })));
    }

    return { rows, count };
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    await AuditLogRepository.log({ entityName: 'guardLicense', entityId: record.id, action, values: data ? { ...record.get({ plain: true }) } : {} }, options);
  }
}

export default GuardLicenseRepository;
