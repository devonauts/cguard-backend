import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import TimeOffRequestRepository from '../database/repositories/timeOffRequestRepository';
import { dispatch } from '../lib/notificationDispatcher';

export default class TimeOffRequestService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await TimeOffRequestRepository.create(data, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);

      // Notify HR of time-off request
      dispatch('timeoff.requested', {
        guardName: record.employeeName || record.guardName ||
          this.options.currentUser?.fullName || this.options.currentUser?.email || null,
        dateRange: record.startDate && record.endDate
          ? `${record.startDate} – ${record.endDate}`
          : (record.startDate || null),
        reason: record.reason || null,
      }, {
        database: this.options.database,
        tenantId: this.options.currentTenant?.id,
        sourceEntityType: 'timeOffRequest',
        sourceEntityId: record.id,
      }).catch(() => {});

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async updateStatus(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await TimeOffRequestRepository.updateStatus(id, data, { ...this.options, transaction });
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
      await TimeOffRequestRepository.destroy(id, { ...this.options, transaction });
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return TimeOffRequestRepository.findById(id, this.options);
  }

  async findAndCountAll(query) {
    const { filter, limit, offset, orderBy } = query;
    return TimeOffRequestRepository.findAndCountAll(
      { filter, limit: limit || 25, offset: offset || 0, orderBy },
      this.options,
    );
  }
}
