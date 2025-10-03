import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import PatrolRepository from '../database/repositories/patrolRepository';
import StationRepository from '../database/repositories/stationRepository';
import PatrolCheckpointRepository from '../database/repositories/patrolCheckpointRepository';
import PatrolLogRepository from '../database/repositories/patrolLogRepository';
import UserRepository from '../database/repositories/userRepository';

export default class PatrolService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.assignedGuard = await UserRepository.filterIdInTenant(data.assignedGuard, { ...this.options, transaction });
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.logs = await PatrolLogRepository.filterIdsInTenant(data.logs, { ...this.options, transaction });

      const record = await PatrolRepository.create(data, {
        ...this.options,
        transaction,
      });

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
        'patrol',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.assignedGuard = await UserRepository.filterIdInTenant(data.assignedGuard, { ...this.options, transaction });
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.logs = await PatrolLogRepository.filterIdsInTenant(data.logs, { ...this.options, transaction });

      const record = await PatrolRepository.update(
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
        'patrol',
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
        await PatrolRepository.destroy(id, {
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
    return PatrolRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return PatrolRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return PatrolRepository.findAndCountAll(
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
    const count = await PatrolRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
