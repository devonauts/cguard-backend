import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import KpiRepository from '../database/repositories/kpiRepository';

export default class KpiService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await KpiRepository.create(data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await KpiRepository.update(id, data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      for (const id of ids) {
        await KpiRepository.destroy(id, { ...this.options, transaction });
      }
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return KpiRepository.findById(id, this.options);
  }

  async findAndCountAll(args) {
    return KpiRepository.findAndCountAll(args, this.options);
  }

  async findAllAutocomplete(query, limit) {
    return KpiRepository.findAllAutocomplete(query, limit, this.options);
  }
}
