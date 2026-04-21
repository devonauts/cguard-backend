import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import InventoryRepository from '../database/repositories/inventoryRepository';
import StationRepository from '../database/repositories/stationRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';

export default class InventoryService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // `belongsTo` may be either a station id or a postSite id. Try station first, then postSite.
      const stationMatch = await StationRepository.filterIdInTenant(data.belongsTo, { ...this.options, transaction });
      if (stationMatch) {
        data.belongsTo = stationMatch;
      } else {
        data.belongsTo = await BusinessInfoRepository.filterIdInTenant(data.belongsTo, { ...this.options, transaction });
      }
      // Validate belongsToStation separately if provided.
      data.belongsToStation = await StationRepository.filterIdInTenant(data.belongsToStation, { ...this.options, transaction });

      const record = await InventoryRepository.create(data, {
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
        'inventory',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // `belongsTo` may be either a station id or a postSite id. Try station first, then postSite.
      const stationMatch2 = await StationRepository.filterIdInTenant(data.belongsTo, { ...this.options, transaction });
      if (stationMatch2) {
        data.belongsTo = stationMatch2;
      } else {
        data.belongsTo = await BusinessInfoRepository.filterIdInTenant(data.belongsTo, { ...this.options, transaction });
      }
      // Validate belongsToStation separately if provided.
      data.belongsToStation = await StationRepository.filterIdInTenant(data.belongsToStation, { ...this.options, transaction });

      const record = await InventoryRepository.update(
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
        'inventory',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize incoming ids to an array so we accept:
      // - Array of ids
      // - JSON string like '["id1","id2"]'
      // - Comma-separated string 'id1,id2'
      // - Object with numeric keys
      let idsArray: any[] = [];
      if (!ids) {
        idsArray = [];
      } else if (Array.isArray(ids)) {
        idsArray = ids;
      } else if (typeof ids === 'string') {
        const raw = ids.trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            idsArray = parsed;
          } else if (typeof parsed === 'string') {
            idsArray = parsed.split(',').map((s) => s.trim()).filter(Boolean);
          } else {
            idsArray = [parsed];
          }
        } catch (err) {
          idsArray = raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
      } else if (typeof ids === 'object') {
        try {
          if (typeof (ids as any).length === 'number') {
            idsArray = Array.from(ids as any);
          } else {
            idsArray = Object.values(ids as any).map(String);
          }
        } catch (err) {
          idsArray = [];
        }
      } else {
        idsArray = [ids];
      }

      for (const id of idsArray) {
        await InventoryRepository.destroy(id, {
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
    return InventoryRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return InventoryRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return InventoryRepository.findAndCountAll(
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
    const count = await InventoryRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
