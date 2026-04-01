import AttachmentRepository from '../database/repositories/attachmentRepository';
import { IServiceOptions } from './IServiceOptions';

export default class AttachmentService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    return AttachmentRepository.create(data, this.options);
  }

  async update(id, data) {
    return AttachmentRepository.update(id, data, this.options);
  }

  async destroy(id) {
    return AttachmentRepository.destroy(id, this.options);
  }

  async findAndCountAll(args) {
    return AttachmentRepository.findAndCountAll(args, this.options);
  }

  async findById(id) {
    return AttachmentRepository.findById(id, this.options);
  }
}
