import TenantRepository from '../database/repositories/tenantRepository';
import { IServiceOptions } from './IServiceOptions';

export default class TenantUrlService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async isUrlAvailable(url) {
    const regex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!url || typeof url !== 'string' || url.length > 50 || !regex.test(url)) {
      return { available: false, reason: 'invalid' };
    }

    // check forbidden list from tenantRepository
    const forbidden = ['www','admin','api','root','support','billing','static','dashboard'];
    if (forbidden.includes(url)) {
      return { available: false, reason: 'reserved' };
    }

    const count = await TenantRepository.count({ url }, this.options);
    if (count > 0) {
      return { available: false, reason: 'exists' };
    }

    return { available: true };
  }
}
