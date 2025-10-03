import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import GuardShiftRepository from '../database/repositories/guardShiftRepository';
import StationRepository from '../database/repositories/stationRepository';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';
import InventoryHistoryRepository from '../database/repositories/inventoryHistoryRepository';
import PatrolLogRepository from '../database/repositories/patrolLogRepository';
import IncidentRepository from '../database/repositories/incidentRepository';

export default class GuardShiftService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationName = await StationRepository.filterIdInTenant(data.stationName, { ...this.options, transaction });
      data.guardName = await SecurityGuardRepository.filterIdInTenant(data.guardName, { ...this.options, transaction });
      data.completeInventoryCheck = await InventoryHistoryRepository.filterIdInTenant(data.completeInventoryCheck, { ...this.options, transaction });
      data.patrolsDone = await PatrolLogRepository.filterIdsInTenant(data.patrolsDone, { ...this.options, transaction });
      data.dailyIncidents = await IncidentRepository.filterIdsInTenant(data.dailyIncidents, { ...this.options, transaction });

      const record = await GuardShiftRepository.create(data, {
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
        'guardShift',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationName = await StationRepository.filterIdInTenant(data.stationName, { ...this.options, transaction });
      data.guardName = await SecurityGuardRepository.filterIdInTenant(data.guardName, { ...this.options, transaction });
      data.completeInventoryCheck = await InventoryHistoryRepository.filterIdInTenant(data.completeInventoryCheck, { ...this.options, transaction });
      data.patrolsDone = await PatrolLogRepository.filterIdsInTenant(data.patrolsDone, { ...this.options, transaction });
      data.dailyIncidents = await IncidentRepository.filterIdsInTenant(data.dailyIncidents, { ...this.options, transaction });

      const record = await GuardShiftRepository.update(
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
        'guardShift',
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
        await GuardShiftRepository.destroy(id, {
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
    return GuardShiftRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return GuardShiftRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return GuardShiftRepository.findAndCountAll(
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
    const count = await GuardShiftRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
