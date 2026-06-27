import lodash from 'lodash';
import { Op } from 'sequelize';
import Error404 from '../../errors/Error404';
import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

export default class InventoryAssignmentRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryAssignment.create(
      {
        ...lodash.pick(data, [
          'inventoryItemId', 'stationId', 'postSiteId', 'assignedToUserId',
          'assignedAt', 'returnedAt', 'conditionAtCheckout', 'conditionAtReturn',
          'notes', 'returnNotes', 'importHash',
        ]),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    // Update inventoryItem status to 'asignado' when there's no returnedAt
    if (!data.returnedAt) {
      await options.database.inventoryItem.update(
        { status: 'asignado', updatedById: currentUser.id },
        { where: { id: data.inventoryItemId }, transaction },
      );
    }

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    let record = await options.database.inventoryAssignment.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    record = await record.update(
      {
        ...lodash.pick(data, [
          'stationId', 'postSiteId', 'assignedToUserId',
          'assignedAt', 'returnedAt', 'conditionAtCheckout', 'conditionAtReturn',
          'notes', 'returnNotes', 'importHash',
        ]),
        updatedById: currentUser.id,
      },
      { transaction },
    );

    // Update inventoryItem status based on returnedAt
    const itemStatus = data.returnedAt ? 'disponible' : 'asignado';
    await options.database.inventoryItem.update(
      { status: itemStatus, updatedById: currentUser.id },
      { where: { id: record.inventoryItemId }, transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryAssignment.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) throw new Error404();

    // Free up the item when its only active assignment is deleted
    const activeAssignments = await options.database.inventoryAssignment.count({
      where: {
        inventoryItemId: record.inventoryItemId,
        returnedAt: null,
        id: { [Op.ne]: id },
        tenantId: currentTenant.id,
      },
      transaction,
    });

    if (activeAssignments === 0) {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      await options.database.inventoryItem.update(
        { status: 'disponible', updatedById: currentUser.id },
        { where: { id: record.inventoryItemId }, transaction },
      );
    }

    await record.destroy({ transaction });
    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.inventoryAssignment.findOne({
      where: { id, tenantId: currentTenant.id },
      include: [
        { model: options.database.inventoryItem, as: 'inventoryItem' },
        { model: options.database.station, as: 'station', required: false },
        {
          model: options.database.user,
          as: 'assignedTo',
          required: false,
          attributes: ['id', 'firstName', 'lastName', 'email', 'avatars'],
        },
      ],
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
      if (filter.stationId) where.stationId = filter.stationId;
      if (filter.postSiteId) where.postSiteId = filter.postSiteId;
      if (filter.inventoryItemId) where.inventoryItemId = filter.inventoryItemId;
      if (filter.assignedToUserId) where.assignedToUserId = filter.assignedToUserId;
      if (filter.active === 'true' || filter.active === true) {
        where.returnedAt = null;
      }
    }

    const [field, direction] = (orderBy || 'createdAt_DESC').split('_');
    const order: any[] = [[field || 'createdAt', direction || 'DESC']];

    const { rows, count } = await options.database.inventoryAssignment.findAndCountAll({
      // LEAN list (payload-perf): explicit root columns (stationId/postSiteId are
      // kept for the frontend's client-side station grouping/filter).
      attributes: [
        'id', 'inventoryItemId', 'stationId', 'postSiteId', 'assignedToUserId',
        'assignedAt', 'returnedAt', 'conditionAtCheckout', 'conditionAtReturn',
        'notes', 'returnNotes', 'createdAt', 'updatedAt',
      ],
      where,
      order,
      limit: Number(limit),
      offset: Number(offset),
      include: [
        // Only the item columns the list renders (name/serial/condition/type).
        {
          model: options.database.inventoryItem,
          as: 'inventoryItem',
          required: false,
          attributes: ['id', 'name', 'type', 'serialNumber', 'condition', 'status'],
        },
        // The full `station` object was never read on assignment rows (the CRM
        // groups by station via a separate fetch using stationId), so it is
        // dropped from the list. findById keeps the full station include.
        {
          model: options.database.user,
          as: 'assignedTo',
          required: false,
          attributes: ['id', 'firstName', 'lastName', 'email'],
        },
      ],
      transaction,
    });

    return {
      rows: await Promise.all(rows.map((r) => this._fillWithRelationsAndFiles(r, options))),
      count,
    };
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    if (!id) return null;
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const record = await options.database.inventoryAssignment.findOne({
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
          entityName: 'inventoryAssignment',
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
    return output;
  }
}
