import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';

const Op = Sequelize.Op;

class NoteRepository {
  static async create(data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const createData = {
      title: data.title,
      description: data.description,
      noteDate: data.noteDate || null,
      attachment: data.attachment || null,
      notableType: data.notableType,
      notableId: data.notableId,
      tenantId: tenant.id,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    };

    const record = await options.database.note.create(createData, { transaction });

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async update(id, data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.note.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        title: data.title,
        description: data.description || null,
        noteDate: data.noteDate || null,
        attachment: data.attachment || null,
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

    let record = await options.database.note.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);

    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const record = await options.database.note.findOne({ where: { id, tenantId: currentTenant.id }, transaction });

    if (!record) {
      throw new Error404();
    }

    return record.get({ plain: true });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: any[] = [{ tenantId: tenant.id }];

    if (filter) {
      if (filter.notableType) {
        whereAnd.push({ notableType: filter.notableType });
      }
      if (filter.notableId) {
        whereAnd.push({ notableId: SequelizeFilterUtils.uuid(filter.notableId) });
      }
      if (filter.title) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('note', 'title', filter.title));
      }
      if (filter.description) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('note', 'description', filter.description));
      }
    }

    const where = { [Op.and]: whereAnd };

    // Include createdBy/updatedBy user info when available so frontend can show names
    const include: any[] = [];
    try {
      if (options.database && options.database.user) {
        include.push({ model: options.database.user, as: 'createdBy', attributes: ['id', 'fullName'] });
        include.push({ model: options.database.user, as: 'updatedBy', attributes: ['id', 'fullName'] });
      }
    } catch (e) {
      // ignore if user model not present in options.database
    }

    let { rows, count } = await options.database.note.findAndCountAll({
      where,
      include: include.length ? include : undefined,
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

    await AuditLogRepository.log({ entityName: 'note', entityId: record.id, action, values }, options);
  }
}

export default NoteRepository;