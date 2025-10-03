import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import StationRepository from '../database/repositories/stationRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import TaskRepository from '../database/repositories/taskRepository';
import ReportRepository from '../database/repositories/reportRepository';
import IncidentRepository from '../database/repositories/incidentRepository';
import PatrolCheckpointRepository from '../database/repositories/patrolCheckpointRepository';
import PatrolRepository from '../database/repositories/patrolRepository';
import ShiftRepository from '../database/repositories/shiftRepository';
import UserRepository from '../database/repositories/userRepository';

export default class StationService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationOrigin = await ClientAccountRepository.filterIdInTenant(data.stationOrigin, { ...this.options, transaction });
      data.assignedGuards = await UserRepository.filterIdsInTenant(data.assignedGuards, { ...this.options, transaction });
      data.tasks = await TaskRepository.filterIdsInTenant(data.tasks, { ...this.options, transaction });
      data.reports = await ReportRepository.filterIdsInTenant(data.reports, { ...this.options, transaction });
      data.incidents = await IncidentRepository.filterIdsInTenant(data.incidents, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdsInTenant(data.patrol, { ...this.options, transaction });
      data.shift = await ShiftRepository.filterIdsInTenant(data.shift, { ...this.options, transaction });

      const record = await StationRepository.create(data, {
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
        'station',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationOrigin = await ClientAccountRepository.filterIdInTenant(data.stationOrigin, { ...this.options, transaction });
      data.assignedGuards = await UserRepository.filterIdsInTenant(data.assignedGuards, { ...this.options, transaction });
      data.tasks = await TaskRepository.filterIdsInTenant(data.tasks, { ...this.options, transaction });
      data.reports = await ReportRepository.filterIdsInTenant(data.reports, { ...this.options, transaction });
      data.incidents = await IncidentRepository.filterIdsInTenant(data.incidents, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdsInTenant(data.patrol, { ...this.options, transaction });
      data.shift = await ShiftRepository.filterIdsInTenant(data.shift, { ...this.options, transaction });

      const record = await StationRepository.update(
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
        'station',
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
        await StationRepository.destroy(id, {
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
    return StationRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return StationRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return StationRepository.findAndCountAll(
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
    const count = await StationRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
