import Sequelize from 'sequelize';
import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class ShiftExchangeRequestRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    // Validate the referenced shifts belong to this tenant and DERIVE the guard
    // ids from them — never trust client-supplied from/to guard ids (forgeable).
    let fromShift: any = null;
    let toShift: any = null;
    if (data.fromShiftId) {
      fromShift = await options.database.shift.findOne({ where: { id: data.fromShiftId, tenantId: tenant.id }, transaction });
      if (!fromShift) throw Object.assign(new Error('Turno de origen no válido para este inquilino.'), { code: 400 });
    }
    if (data.toShiftId) {
      toShift = await options.database.shift.findOne({ where: { id: data.toShiftId, tenantId: tenant.id }, transaction });
      if (!toShift) throw Object.assign(new Error('Turno destino no válido para este inquilino.'), { code: 400 });
    }

    const record = await options.database.shiftExchangeRequest.create(
      {
        requestDate: data.requestDate || new Date(),
        fromShiftId: fromShift ? fromShift.id : null,
        toShiftId: toShift ? toShift.id : null,
        fromGuardId: (fromShift && fromShift.guardId) || data.fromGuardId || null,
        toGuardId: (toShift && toShift.guardId) || data.toGuardId || null,
        notes: data.notes || null,
        status: 'pending',
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'shiftExchangeRequest', entityId: record.id, action: AuditLogRepository.CREATE, values: { ...record.get({ plain: true }) } },
      options,
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

    // On APPROVAL, actually perform the swap (previously a no-op: status flipped
    // but the shifts never moved). fromShift goes to toGuard; if a toShift was
    // offered it goes to fromGuard. Each move is overlap-checked so the exchange
    // can't double-book either guard.
    if (data.status === 'approved' && record.status !== 'approved') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findGuardShiftOverlap } = require('../../services/shiftOverlap');
      const db = options.database;

      const fromShift = record.fromShiftId
        ? await db.shift.findOne({ where: { id: record.fromShiftId, tenantId: tenant.id }, transaction })
        : null;
      const toShift = record.toShiftId
        ? await db.shift.findOne({ where: { id: record.toShiftId, tenantId: tenant.id }, transaction })
        : null;

      if (!fromShift) {
        throw Object.assign(new Error('El turno de origen ya no existe.'), { code: 400 });
      }
      const toGuardId = record.toGuardId || (toShift && toShift.guardId);
      if (!toGuardId) {
        throw Object.assign(new Error('No hay vigilante destino para el intercambio.'), { code: 400 });
      }
      const fromGuardId = record.fromGuardId || fromShift.guardId;

      // toGuard takes fromShift → must be free at that time (excluding a toShift
      // they're giving up). fromGuard takes toShift → likewise.
      const conflictTo = await findGuardShiftOverlap(db, tenant.id, toGuardId, fromShift.startTime, fromShift.endTime, { excludeShiftId: toShift ? toShift.id : undefined, transaction });
      if (conflictTo) {
        throw Object.assign(new Error('El vigilante destino ya tiene un turno que se solapa con este intercambio.'), { code: 400 });
      }
      if (toShift) {
        const conflictFrom = await findGuardShiftOverlap(db, tenant.id, fromGuardId, toShift.startTime, toShift.endTime, { excludeShiftId: fromShift.id, transaction });
        if (conflictFrom) {
          throw Object.assign(new Error('El vigilante solicitante ya tiene un turno que se solapa con este intercambio.'), { code: 400 });
        }
        await toShift.update({ guardId: fromGuardId, updatedById: currentUser.id }, { transaction });
      }
      await fromShift.update({ guardId: toGuardId, updatedById: currentUser.id }, { transaction });
    }

    await record.update(
      {
        status: data.status,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      { entityName: 'shiftExchangeRequest', entityId: record.id, action: AuditLogRepository.UPDATE, values: { ...record.get({ plain: true }) } },
      options,
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

    const snapshot = { ...record.get({ plain: true }) };
    await record.destroy({ transaction });

    await AuditLogRepository.log(
      { entityName: 'shiftExchangeRequest', entityId: id, action: AuditLogRepository.DELETE, values: snapshot },
      options,
    );
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
