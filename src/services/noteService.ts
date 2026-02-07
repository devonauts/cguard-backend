import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import NoteRepository from '../database/repositories/noteRepository';

export default class NoteService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    return NoteRepository.create(data, this.options);
  }

  async update(id, data) {
    return NoteRepository.update(id, data, this.options);
  }

  async destroy(id) {
    return NoteRepository.destroy(id, this.options);
  }

  async findAndCountAll(args) {
    return NoteRepository.findAndCountAll(args, this.options);
  }

  async findById(id) {
    return NoteRepository.findById(id, this.options);
  }
}