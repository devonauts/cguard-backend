import SequelizeRepository from '../database/repositories/sequelizeRepository';
import InventoryItemRepository from '../database/repositories/inventoryItemRepository';

export default class InventoryItemService {
  options: any;

  constructor(req) {
    this.options = req;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options);
    try {
      const record = await InventoryItemRepository.create(data, {
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
    const transaction = await SequelizeRepository.createTransaction(this.options);
    try {
      const record = await InventoryItemRepository.update(id, data, {
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
    const transaction = await SequelizeRepository.createTransaction(this.options);
    try {
      const idList = Array.isArray(ids) ? ids : [ids];
      for (const id of idList) {
        await InventoryItemRepository.destroy(id, { ...this.options, transaction });
      }
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return InventoryItemRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return InventoryItemRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return InventoryItemRepository.findAndCountAll(args, this.options);
  }
}
