import SequelizeRepository from '../database/repositories/sequelizeRepository';
import LicenseTypeRepository from '../database/repositories/licenseTypeRepository';

class LicenseTypeService {
  options: any;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await LicenseTypeRepository.create(data, this.options);
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
      const record = await LicenseTypeRepository.update(id, data, this.options);
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
      await LicenseTypeRepository.destroyAll(ids, this.options);
      await SequelizeRepository.commitTransaction(transaction);
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async findById(id) {
    return LicenseTypeRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return LicenseTypeRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(params) {
    return LicenseTypeRepository.findAndCountAll(params, this.options);
  }
}

export default LicenseTypeService;
