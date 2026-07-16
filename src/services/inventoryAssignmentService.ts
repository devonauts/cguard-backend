import SequelizeRepository from '../database/repositories/sequelizeRepository';
import InventoryAssignmentRepository from '../database/repositories/inventoryAssignmentRepository';

export default class InventoryAssignmentService {
  options: any;

  constructor(req) {
    this.options = req;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await InventoryAssignmentRepository.create(data, {
        ...this.options,
        transaction,
      });
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
      const record = await InventoryAssignmentRepository.update(id, data, {
        ...this.options,
        transaction,
      });
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
      const idList = Array.isArray(ids) ? ids : [ids];
      for (const id of idList) {
        await InventoryAssignmentRepository.destroy(id, { ...this.options, transaction });
      }
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return InventoryAssignmentRepository.findById(id, this.options);
  }

  async findAndCountAll(args) {
    return InventoryAssignmentRepository.findAndCountAll(args, this.options);
  }
}
