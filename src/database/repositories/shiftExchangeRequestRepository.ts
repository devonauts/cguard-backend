import Sequelize from 'sequelize';
import SequelizeRepository from './sequelizeRepository';
import Error404 from '../../errors/Error404';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class ShiftExchangeRequestRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftExchangeRequest.create(
      {
        requestDate: data.requestDate || new Date(),
        fromShiftId: data.fromShiftId || null,
        toShiftId: data.toShiftId || null,
        fromGuardId: data.fromGuardId || null,
        toGuardId: data.toGuardId || null,
        notes: data.notes || null,
        status: 'pending',
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    return this.findById(record.id, options);
  }

  static async updateStatus(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftExchangeRequest.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.update(
      {
        status: data.status,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftExchangeRequest.findOne({
      where: { id, tenantId: tenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });
  }

  static async findById(id, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.shiftExchangeRequest.findOne({
      where: { id, tenantId: tenant.id },
      include: [
        { model: options.database.user, as: 'fromGuard', attributes: ['id', 'fullName', 'email'] },
        { model: options.database.user, as: 'toGuard', attributes: ['id', 'fullName', 'email'] },
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

      if (filter.fromGuardId) {
        whereAnd.push({ fromGuardId: filter.fromGuardId });
      }

      if (filter.toGuardId) {
        whereAnd.push({ toGuardId: filter.toGuardId });
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

    const { rows, count } = await options.database.shiftExchangeRequest.findAndCountAll({
      where,
      include: [
        { model: options.database.user, as: 'fromGuard', attributes: ['id', 'fullName', 'email'] },
        { model: options.database.user, as: 'toGuard', attributes: ['id', 'fullName', 'email'] },
      ],
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['requestDate', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    return { rows: rows.map((r) => r.get({ plain: true })), count };
  }
}

export default ShiftExchangeRequestRepository;
