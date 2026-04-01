import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';

const Op = Sequelize.Op;

class AttachmentRepository {
  static async create(data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const createData = {
      name: data.name,
      mimeType: data.mimeType,
      sizeInBytes: data.sizeInBytes,
      storageId: data.storageId,
      privateUrl: data.privateUrl,
      publicUrl: data.publicUrl || null,
      notableType: data.notableType,
      notableId: data.notableId,
      tenantId: tenant.id,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    };

    const record = await options.database.attachment.create(createData, { transaction });

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.attachment.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        name: data.name,
        mimeType: data.mimeType,
        sizeInBytes: data.sizeInBytes,
        storageId: data.storageId,
        privateUrl: data.privateUrl,
        publicUrl: data.publicUrl || null,
        notableType: data.notableType,
        notableId: data.notableId,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.attachment.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    // Attempt to delete remote file first (best-effort)
    try {
      const FileStorage = require('../../services/file/fileStorage').default;
      if (record.privateUrl) {
        await FileStorage.delete(record.privateUrl);
      }
    } catch (e) {
      // Log and continue - do not fail DB delete because of remote delete issue
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('Failed to delete remote file for attachment', id, msg);
    }

    await record.destroy({ transaction });
  }

  static async findByNotableIds(notableType, ids: string[], options) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const where = {
      tenantId: currentTenant.id,
      notableType,
      notableId: ids,
    };

    const rows = await options.database.attachment.findAll({ where, transaction, order: [['createdAt', 'DESC']] });
    return rows.map((r) => r.get({ plain: true }));
  }

  static async findById(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.attachment.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    return record.get({ plain: true });
  }

  static async findAndCountAll({ filter, limit = 25, offset = 0 }, options) {
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: any = [];

    whereAnd.push({ tenantId: currentTenant.id });

    if (filter) {
      if (filter.notableType) {
        whereAnd.push({ notableType: filter.notableType });
      }
      if (filter.notableId) {
        whereAnd.push({ notableId: filter.notableId });
      }
    }

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.attachment.findAndCountAll({
      where,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    return { rows, count };
  }

  static async _createAuditLog(action, record, data, options) {
    try {
      let values = {};
      if (data) {
        values = { ...record.get({ plain: true }) };
      }

      await AuditLogRepository.log({ entityName: 'attachment', entityId: record.id, action, values }, options);
    } catch (e) {
      // ignore audit log errors
    }
  }
}

export default AttachmentRepository;
