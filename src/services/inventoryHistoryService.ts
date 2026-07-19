import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import InventoryHistoryRepository from '../database/repositories/inventoryHistoryRepository';
import GuardShiftRepository from '../database/repositories/guardShiftRepository';
import InventoryRepository from '../database/repositories/inventoryRepository';
import PatrolRepository from '../database/repositories/patrolRepository';
import PatrolCheckpointRepository from '../database/repositories/patrolCheckpointRepository';

export default class InventoryHistoryService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.shiftOrigin = await GuardShiftRepository.filterIdInTenant(data.shiftOrigin, { ...this.options, transaction });
      data.inventoryOrigin = await InventoryRepository.filterIdInTenant(data.inventoryOrigin, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdInTenant(data.patrol, { ...this.options, transaction });
      data.patrolCheckpoint = await PatrolCheckpointRepository.filterIdInTenant(data.patrolCheckpoint, { ...this.options, transaction });

      const record = await InventoryHistoryRepository.create(data, {
        ...this.options,
        transaction,
      });

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      // CRM realtime feed (bell): supervisors/admins see the inventory check,
      // like every other guard action. Best-effort, fire-and-forget — after the
      // commit, so a notification failure never breaks the create.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { dispatch } = require('../lib/notificationDispatcher');
        const db = this.options.database;
        const tenantId = this.options.currentTenant && this.options.currentTenant.id;
        const cu = this.options.currentUser;
        let guardName = (cu && (cu.fullName || cu.email)) || null;
        try {
          if (cu && cu.id) {
            const sg = await db.securityGuard.findOne({
              where: { guardId: cu.id, tenantId, deletedAt: null },
              attributes: ['fullName'],
            });
            if (sg && sg.fullName) guardName = sg.fullName;
          }
        } catch { /* ignore */ }
        let stationName: any = null;
        let postSiteId: any;
        try {
          if (data.stationId) {
            const st = await db.station.findByPk(data.stationId, {
              attributes: ['stationName', 'postSiteId'],
            });
            stationName = (st && st.stationName) || null;
            postSiteId = (st && st.postSiteId) || undefined;
          }
        } catch { /* ignore */ }
        await dispatch(
          'inventory.checked',
          { guardName, stationName, isComplete: data.isComplete !== false },
          {
            database: db,
            tenantId,
            sourceEntityType: 'inventoryHistory',
            sourceEntityId: (record as any) && (record as any).id,
            assignedPostSiteId: postSiteId,
          },
        );
      } catch (e) {
        console.error('[inventoryHistory] dispatch failed:', (e as any)?.message || e);
      }

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'inventoryHistory',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.shiftOrigin = await GuardShiftRepository.filterIdInTenant(data.shiftOrigin, { ...this.options, transaction });
      data.inventoryOrigin = await InventoryRepository.filterIdInTenant(data.inventoryOrigin, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdInTenant(data.patrol, { ...this.options, transaction });
      data.patrolCheckpoint = await PatrolCheckpointRepository.filterIdInTenant(data.patrolCheckpoint, { ...this.options, transaction });

      const record = await InventoryHistoryRepository.update(
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
        'inventoryHistory',
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
        await InventoryHistoryRepository.destroy(id, {
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
    return InventoryHistoryRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return InventoryHistoryRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return InventoryHistoryRepository.findAndCountAll(
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
    const count = await InventoryHistoryRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
