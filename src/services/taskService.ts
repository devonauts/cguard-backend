import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import TaskRepository from '../database/repositories/taskRepository';
import StationRepository from '../database/repositories/stationRepository';

export default class TaskService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.taskBelongsToStation = await StationRepository.filterIdInTenant(data.taskBelongsToStation, { ...this.options, transaction });

      // Staff (CRM) created tasks skip approval — they're auto-approved and assigned.
      const currentUser = SequelizeRepository.getCurrentUser(this.options);
      if (!data.status) data.status = 'approved';
      if (!data.source) data.source = 'staff';
      if (data.status === 'approved') {
        data.approvedById = currentUser.id;
        data.approvedAt = new Date();
      }

      const record = await TaskRepository.create(data, {
        ...this.options,
        transaction,
      });

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      // Approved on creation → push the station guards + notify the client. Best-effort.
      if (record && record.status === 'approved') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { notifyTaskApproved } = require('./taskNotify');
          notifyTaskApproved(
            this.options.database,
            this.options.currentTenant?.id,
            record.get ? record.get({ plain: true }) : record,
          ).catch(() => undefined);
        } catch (e: any) {
          console.warn('[task] staff-create notify failed:', e?.message || e);
        }
      }

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'task',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.taskBelongsToStation = await StationRepository.filterIdInTenant(data.taskBelongsToStation, { ...this.options, transaction });

      const record = await TaskRepository.update(
        id,
        data,
        {
          ...this.options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'task',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        await TaskRepository.destroy(id, {
          ...this.options,
          transaction,
        });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async findById(id) {
    return TaskRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return TaskRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return TaskRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashRequired',
      );
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashExistent',
      );
    }

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await TaskRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
