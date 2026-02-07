import Error404 from '../errors/Error404';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ClientContactRepository from '../database/repositories/clientContactRepository';

export default class ClientContactService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    return ClientContactRepository.create(data, this.options);
  }

  async update(id, data) {
    return ClientContactRepository.update(id, data, this.options);
  }

  async destroy(id) {
    return ClientContactRepository.destroy(id, this.options);
  }

  async findAndCountAll(args) {
    return ClientContactRepository.findAndCountAll(args, this.options);
  }

  async findById(id) {
    return ClientContactRepository.findById(id, this.options);
  }
}
