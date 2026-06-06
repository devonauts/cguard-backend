import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ShiftRepository from '../database/repositories/shiftRepository';
import StationRepository from '../database/repositories/stationRepository';
import UserRepository from '../database/repositories/userRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import { resolveGuardUserId } from './guardIdResolver';

export default class ShiftService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  /**
   * Guard against double-booking: a guard cannot hold two shifts whose time
   * ranges overlap. Two ranges [aStart,aEnd) and [bStart,bEnd) overlap iff
   * aStart < bEnd && bStart < aEnd. Throws Error400 when an overlap exists.
   * `excludeId` lets update() ignore the record being edited.
   */
  async _assertNoGuardOverlap(data, transaction, excludeId?) {
    const Sequelize = this.options.database.Sequelize;
    const Op = Sequelize.Op;

    const guardId = data.guard;
    if (!guardId || !data.startTime || !data.endTime) {
      return;
    }

    const tenant = SequelizeRepository.getCurrentTenant(this.options);

    const where: any = {
      tenantId: tenant.id,
      guardId,
      // existing.startTime < new.endTime  AND  existing.endTime > new.startTime
      startTime: { [Op.lt]: data.endTime },
      endTime: { [Op.gt]: data.startTime },
    };
    if (excludeId) {
      where.id = { [Op.ne]: excludeId };
    }

    const conflict = await this.options.database.shift.findOne({
      where,
      transaction,
    });

    if (conflict) {
      throw new Error400(
        this.options.language,
        'entities.shift.errors.guardOverlap',
      );
    }
  }

  /**
   * Resolve the UI's "guard" reference (user id, securityGuard id, or
   * `sg:<id>`) to the underlying user id. Throws a clear 400 when a guard was
   * provided but can't be matched — instead of silently saving the shift with
   * `guardId = null`, which makes the turno invisible in the guard's worker-app.
   */
  private async _resolveGuard(rawGuard) {
    const tenant = SequelizeRepository.getCurrentTenant(this.options);
    const { provided, userId } = await resolveGuardUserId(
      this.options.database,
      tenant.id,
      rawGuard,
    );
    if (provided && !userId) {
      throw new Error400(
        this.options.language,
        'entities.shift.errors.guardNotFound',
      );
    }
    return userId;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.guard = await this._resolveGuard(data.guard);
      data.postSite = await BusinessInfoRepository.filterIdInTenant(data.postSite, { ...this.options, transaction });

      await this._assertNoGuardOverlap(data, transaction);
      // tenantUser may be provided as tenantUserId — attempt to filter/validate when possible
      try {
        data.tenantUserId = data.tenantUserId || data.tenantUser || null;
        // If TenantUserRepository exposes filterIdInTenant you can uncomment next line
        // data.tenantUser = await TenantUserRepository.filterIdInTenant(data.tenantUserId, { ...this.options, transaction });
      } catch (e) {
        // ignore
      }

      const record = await ShiftRepository.create(data, {
        ...this.options,
        transaction,
      });

      // NOTE: the redundant `tenant_user_post_sites` side-write was removed.
      // `guardAssignment` is now the single source of truth for assignments and
      // `shifts` are derived from it — no pivot bookkeeping needed here.

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'shift',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.guard = await this._resolveGuard(data.guard);
      data.postSite = await BusinessInfoRepository.filterIdInTenant(data.postSite, { ...this.options, transaction });
      try {
        data.tenantUserId = data.tenantUserId || data.tenantUser || null;
      } catch (e) {
        // ignore
      }

      await this._assertNoGuardOverlap(data, transaction, id);

      const record = await ShiftRepository.update(
        id,
        data,
        {
          ...this.options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'shift',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        await ShiftRepository.destroy(id, {
          ...this.options,
          transaction,
        });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async findById(id) {
    return ShiftRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return ShiftRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return ShiftRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashRequired',
      );
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashExistent',
      );
    }

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await ShiftRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
