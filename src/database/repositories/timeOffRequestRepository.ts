import Sequelize from 'sequelize';
import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class TimeOffRequestRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.timeOffRequest.create(
      {
        requestDate: data.requestDate || new Date(),
        type: data.type || null,
        startDate: data.startDate || null,
        startTime: data.startTime || null,
        endDate: data.endDate || null,
        endTime: data.endTime || null,
        reason: data.reason || null,
        comment: null,
        status: 'pending',
        isPaid: data.isPaid || false,
        guardId: data.guard || data.guardId || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'timeOffRequest', entityId: record.id, action: AuditLogRepository.CREATE, values: { ...record.get({ plain: true }) } },
      options,
    );

    return this.findById(record.id, options);
  }

  static async updateStatus(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.timeOffRequest.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.update(
      {
        status: data.status,
        comment: data.comment ?? record.comment,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'timeOffRequest', entityId: record.id, action: AuditLogRepository.UPDATE, values: { ...record.get({ plain: true }) } },
      options,
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.timeOffRequest.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const snapshot = { ...record.get({ plain: true }) };
    await record.destroy({ transaction });

    await AuditLogRepository.log(
      { entityName: 'timeOffRequest', entityId: id, action: AuditLogRepository.DELETE, values: snapshot },
      options,
    );
  }

  static async findById(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.timeOffRequest.findOne({
      where: { id, tenantId: tenant.id },
      include: [
        { model: options.database.user, as: 'guard', attributes: ['id', 'fullName', 'email'] },
      ],
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

      if (filter.guardId) {
        whereAnd.push({ guardId: filter.guardId });
      }

      if (filter.requestDateRange) {
        const [start, end] = filter.requestDateRange;
        if (start) {
          whereAnd.push({ requestDate: { [Op.gte]: start } });
        }
        if (end) {
          whereAnd.push({ requestDate: { [Op.lte]: end } });
        }
      }
    }

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.timeOffRequest.findAndCountAll({
      where,
      include: [
        { model: options.database.user, as: 'guard', attributes: ['id', 'fullName', 'email'] },
      ],
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['requestDate', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    return { rows: rows.map((r) => r.get({ plain: true })), count };
  }
}

export default TimeOffRequestRepository;
