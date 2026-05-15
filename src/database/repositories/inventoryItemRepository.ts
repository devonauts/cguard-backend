import lodash from 'lodash';
import { Op } from 'sequelize';
import Error404 from '../../errors/Error404';
import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

export default class InventoryItemRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryItem.create(
      {
        ...lodash.pick(data, [
          'name', 'type', 'brand', 'modelName', 'serialNumber',
          'condition', 'status', 'notes', 'expirationDate', 'importHash',
        ]),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    if (data.photos !== undefined) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.inventoryItem.getTableName(),
          belongsToColumn: 'photos',
          belongsToId: record.id,
        },
        data.photos,
        options,
      );
    }

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    let record = await options.database.inventoryItem.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    record = await record.update(
      {
        ...lodash.pick(data, [
          'name', 'type', 'brand', 'modelName', 'serialNumber',
          'condition', 'status', 'notes', 'expirationDate', 'importHash',
        ]),
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    if (data.photos !== undefined) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.inventoryItem.getTableName(),
          belongsToColumn: 'photos',
          belongsToId: record.id,
        },
        data.photos,
        options,
      );
    }

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryItem.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    await record.destroy({ transaction });
    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryItem.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async findAndCountAll(
    { filter, limit = 25, offset = 0, orderBy = 'createdAt_DESC' } = {} as any,
    options: IRepositoryOptions,
  ) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const where: any = { tenantId: currentTenant.id };

    if (filter) {
      if (filter.id) where.id = filter.id;
      if (filter.name) where.name = { [Op.like]: `%${filter.name}%` };
      if (filter.type) where.type = filter.type;
      if (filter.status) where.status = filter.status;
      if (filter.condition) where.condition = filter.condition;
      if (filter.serialNumber) where.serialNumber = { [Op.like]: `%${filter.serialNumber}%` };
    }

    const [field, direction] = (orderBy || 'createdAt_DESC').split('_');
    const order: any[] = [[field || 'createdAt', direction || 'DESC']];

    const { rows, count } = await options.database.inventoryItem.findAndCountAll({
      where,
      order,
      limit: Number(limit),
      offset: Number(offset),
      transaction,
    });

    return {
      rows: await Promise.all(rows.map((r) => this._fillWithRelationsAndFiles(r, options))),
      count,
    };
  }

  static async findAllAutocomplete(search, limit, options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const where: any = { tenantId: currentTenant.id };
    if (search) {
      where[Op.or] = [
        { id: { [Op.like]: `%${search}%` } },
        { name: { [Op.like]: `%${search}%` } },
        { serialNumber: { [Op.like]: `%${search}%` } },
      ];
    }

    const records = await options.database.inventoryItem.findAll({
      attributes: ['id', 'name', 'type', 'serialNumber', 'status'],
      where,
      limit: Number(limit || 100),
      orderBy: [['name', 'ASC']],
      transaction,
    });

    return records.map((r) => ({
      id: r.id,
      label: r.serialNumber ? `${r.name} (${r.serialNumber})` : r.name,
      type: r.type,
      status: r.status,
    }));
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    if (!id) return null;
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const record = await options.database.inventoryItem.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });
    return record ? id : null;
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    if (!options || !options.currentUser) return;
    try {
      await AuditLogRepository.log(
        {
          entityName: 'inventoryItem',
          entityId: record.id,
          action,
          values: data,
        },
        options,
      );
    } catch {}
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) return record;

    const output = record.get({ plain: true });

    output.photos = await FileRepository.fillDownloadUrl(
      await options.database.file.findAll({
        where: {
          belongsTo: options.database.inventoryItem.getTableName(),
          belongsToColumn: 'photos',
          belongsToId: record.id,
        },
        transaction: SequelizeRepository.getTransaction(options),
      }),
    );

    return output;
  }
}
