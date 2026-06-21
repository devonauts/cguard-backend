import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ShiftTemplateRepository from '../database/repositories/shiftTemplateRepository';

export default class ShiftTemplateService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await ShiftTemplateRepository.create(data, { ...this.options, transaction });
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
      const record = await ShiftTemplateRepository.update(id, data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async destroy(id) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      await ShiftTemplateRepository.destroy(id, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return ShiftTemplateRepository.findById(id, this.options);
  }

  async findAndCountAll(query) {
    const { filter, limit, offset, orderBy } = query;
    return ShiftTemplateRepository.findAndCountAll(
      { filter, limit: limit || 0, offset: offset || 0, orderBy },
      this.options,
    );
  }
}
