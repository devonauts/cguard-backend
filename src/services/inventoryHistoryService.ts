import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import InventoryHistoryRepository from '../database/repositories/inventoryHistoryRepository';
import GuardShiftRepository from '../database/repositories/guardShiftRepository';
import InventoryRepository from '../database/repositories/inventoryRepository';

export default class InventoryHistoryService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.shiftOrigin = await GuardShiftRepository.filterIdInTenant(data.shiftOrigin, { ...this.options, transaction });
      data.inventoryOrigin = await InventoryRepository.filterIdInTenant(data.inventoryOrigin, { ...this.options, transaction });

      const record = await InventoryHistoryRepository.create(data, {
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
        'inventoryHistory',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.shiftOrigin = await GuardShiftRepository.filterIdInTenant(data.shiftOrigin, { ...this.options, transaction });
      data.inventoryOrigin = await InventoryRepository.filterIdInTenant(data.inventoryOrigin, { ...this.options, transaction });

      const record = await InventoryHistoryRepository.update(
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
        'inventoryHistory',
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
        await InventoryHistoryRepository.destroy(id, {
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
    return InventoryHistoryRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return InventoryHistoryRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return InventoryHistoryRepository.findAndCountAll(
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
    const count = await InventoryHistoryRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
