import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ShiftExchangeRequestRepository from '../database/repositories/shiftExchangeRequestRepository';

export default class ShiftExchangeRequestService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await ShiftExchangeRequestRepository.create(data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async updateStatus(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await ShiftExchangeRequestRepository.updateStatus(id, data, { ...this.options, transaction });
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
      await ShiftExchangeRequestRepository.destroy(id, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return ShiftExchangeRequestRepository.findById(id, this.options);
  }

  async findAndCountAll(query) {
    return ShiftExchangeRequestRepository.findAndCountAll(query, this.options);
  }
}
