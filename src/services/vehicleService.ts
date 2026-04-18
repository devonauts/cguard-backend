import SequelizeRepository from '../database/repositories/sequelizeRepository';
import VehicleRepository from '../database/repositories/vehicleRepository';
import { IServiceOptions } from './IServiceOptions';

export default class VehicleService {
  options: IServiceOptions;
  constructor(options) {
    this.options = options;
  }

  async findAllAutocomplete(search, limit) {
    return VehicleRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return VehicleRepository.findAndCountAll(args, this.options);
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await VehicleRepository.create(data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await VehicleRepository.update(id, data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      for (const id of ids) {
        await VehicleRepository.destroy(id, { ...this.options, transaction });
      }
      await SequelizeRepository.commitTransaction(transaction);
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async findById(id) {
    return VehicleRepository.findById(id, this.options);
  }
}
