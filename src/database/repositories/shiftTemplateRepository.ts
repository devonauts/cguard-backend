import Sequelize from 'sequelize';
import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class ShiftTemplateRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftTemplate.create(
      {
        templateName: data.templateName,
        startTime: data.startTime,
        endTime: data.endTime,
        repeatShift: data.repeatShift || null,
        repeatBy: data.repeatBy || null,
        postSiteId: data.postSiteId || null,
        guardId: data.guardId || null,
        skillSet: data.skillSet || null,
        department: data.department || null,
        breakDuration: data.breakDuration || null,
        note: data.note || null,
        category: data.category || null,
        status: data.status || 'active',
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'shiftTemplate', entityId: record.id, action: AuditLogRepository.CREATE, values: { ...record.get({ plain: true }) } },
      options,
    );

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftTemplate.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.update(
      {
        // `undefined` = not sent → keep stored value; explicit null/'' = the
        // admin CLEARED the field → persist the clear (?? made clearing
        // impossible: a removed guard/nota silently reverted).
        templateName: data.templateName !== undefined ? data.templateName : record.templateName,
        startTime: data.startTime !== undefined ? data.startTime : record.startTime,
        endTime: data.endTime !== undefined ? data.endTime : record.endTime,
        repeatShift: data.repeatShift !== undefined ? data.repeatShift : record.repeatShift,
        repeatBy: data.repeatBy !== undefined ? data.repeatBy : record.repeatBy,
        postSiteId: data.postSiteId !== undefined ? (data.postSiteId || null) : record.postSiteId,
        guardId: data.guardId !== undefined ? (data.guardId || null) : record.guardId,
        skillSet: data.skillSet !== undefined ? (data.skillSet || null) : record.skillSet,
        department: data.department !== undefined ? (data.department || null) : record.department,
        breakDuration: data.breakDuration !== undefined ? (data.breakDuration || null) : record.breakDuration,
        note: data.note !== undefined ? (data.note || null) : record.note,
        category: data.category !== undefined ? (data.category || null) : record.category,
        status: data.status !== undefined ? data.status : record.status,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'shiftTemplate', entityId: record.id, action: AuditLogRepository.UPDATE, values: { ...record.get({ plain: true }) } },
      options,
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftTemplate.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const snapshot = { ...record.get({ plain: true }) };
    await record.destroy({ transaction });

    await AuditLogRepository.log(
      { entityName: 'shiftTemplate', entityId: id, action: AuditLogRepository.DELETE, values: snapshot },
      options,
    );
  }

  static async findById(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftTemplate.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    return record.get({ plain: true });
  }

  static async findAndCountAll(
    { filter, limit = 0, offset = 0, orderBy = '' },
    options: IRepositoryOptions,
  ) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    const whereAnd: any[] = [{ tenantId: tenant.id }];

    if (filter) {
      if (filter.status) {
        whereAnd.push({ status: filter.status });
      }
      if (filter.category) {
        whereAnd.push({ category: filter.category });
      }
      if (filter.templateName) {
        whereAnd.push({ templateName: { [Op.iLike]: `%${filter.templateName}%` } });
      }
    }

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.shiftTemplate.findAndCountAll({
      where,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['templateName', 'ASC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    return { rows: rows.map((r) => r.get({ plain: true })), count };
  }
}

export default ShiftTemplateRepository;
