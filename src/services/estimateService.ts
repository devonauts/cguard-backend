import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import EstimateRepository from '../database/repositories/estimateRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';

export default class EstimateService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      const record = await EstimateRepository.create(data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'estimate');

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      const record = await EstimateRepository.update(id, data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'estimate');
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      for (const id of ids) {
        await EstimateRepository.destroy(id, { ...this.options, transaction });
      }

      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return EstimateRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return EstimateRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return EstimateRepository.findAndCountAll(args, this.options);
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(this.options.language, 'importer.errors.importHashRequired');
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(this.options.language, 'importer.errors.importHashExistent');
    }

    const dataToCreate = { ...data, importHash };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await EstimateRepository.count({ importHash }, this.options);
    return count > 0;
  }
}
