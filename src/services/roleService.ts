import RoleRepository from '../database/repositories/roleRepository';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import Error404 from '../errors/Error404';

export default class RoleService {
  options;
  constructor(options) {
    this.options = options;
  }

  async create(data) {
    return RoleRepository.create(data, this.options);
  }

  async update(id, data) {
    return RoleRepository.update(id, data, this.options);
  }

  async destroy(id) {
    return RoleRepository.destroy(id, this.options);
  }

  async findById(id) {
    return RoleRepository.findById(id, this.options);
  }

  async findAndCountAll(params) {
    return RoleRepository.findAndCountAll(params, this.options);
  }

  async findAllAutocomplete(query, limit) {
    return RoleRepository.findAllAutocomplete(query, limit, this.options);
  }
}
