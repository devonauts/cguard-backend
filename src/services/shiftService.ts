import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ShiftRepository from '../database/repositories/shiftRepository';
import StationRepository from '../database/repositories/stationRepository';
import UserRepository from '../database/repositories/userRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';

export default class ShiftService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      data.postSite = await BusinessInfoRepository.filterIdInTenant(data.postSite, { ...this.options, transaction });
      // tenantUser may be provided as tenantUserId — attempt to filter/validate when possible
      try {
        data.tenantUserId = data.tenantUserId || data.tenantUser || null;
        // If TenantUserRepository exposes filterIdInTenant you can uncomment next line
        // data.tenantUser = await TenantUserRepository.filterIdInTenant(data.tenantUserId, { ...this.options, transaction });
      } catch (e) {
        // ignore
      }

      const record = await ShiftRepository.create(data, {
        ...this.options,
        transaction,
      });

      // Attempt to create/update tenant_user_post_sites pivot within same transaction
      try {
        const sequelize = this.options.database.sequelize;
        const tenantId = SequelizeRepository.getCurrentTenant(this.options).id;

        // Normalize helper for JSON fields
        const normalizeJsonField = (value) => {
          if (value === undefined || value === null) return null;
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              try { JSON.parse(trimmed); return trimmed; } catch (e) { /* fallthrough */ }
            }
            return JSON.stringify(trimmed);
          }
          if (Array.isArray(value) || typeof value === 'object') {
            try { return JSON.stringify(value); } catch (e) { return null; }
          }
          return JSON.stringify(value);
        };

        const postSiteId = data.postSite || data.postSiteId || record.postSiteId || null;
        // Resolve tenantUserId: prefer provided tenantUserId, else try to resolve from guard (user)
        let tenantUserId = data.tenantUserId || data.tenant_user_id || null;
        if (!tenantUserId && data.guard) {
          try {
            const tenantUser = await TenantUserRepository.findByTenantAndUser(tenantId, data.guard, { ...this.options, transaction });
            if (tenantUser && tenantUser.id) tenantUserId = tenantUser.id;
          } catch (e) {
            // ignore
          }
        }

        // Resolve security_guard_id: try to find securityGuard record by guard user id
        let resolvedSecurityGuardId = null;
        try {
          if (data.guard) {
            const byGuard = await this.options.database.securityGuard.findOne({ where: { guardId: data.guard, tenantId }, transaction });
            if (byGuard && byGuard.id) resolvedSecurityGuardId = byGuard.id;
          }
        } catch (e) {
          // ignore
        }

        if (tenantUserId && postSiteId) {
          // Check if station_id column exists
          let hasStationColumn = false;
          try {
            const desc = await sequelize.getQueryInterface().describeTable('tenant_user_post_sites');
            hasStationColumn = !!desc && Object.prototype.hasOwnProperty.call(desc, 'station_id');
          } catch (e) {
            hasStationColumn = false;
          }

          // Check existing assignment
          const existing = await sequelize.query(
            `SELECT id FROM tenant_user_post_sites WHERE tenantUserId = :tenantUserId AND businessInfoId = :businessInfoId LIMIT 1`,
            { replacements: { tenantUserId, businessInfoId: postSiteId }, type: sequelize.QueryTypes.SELECT, transaction },
          );

          const now = new Date();

          if (existing && existing.length > 0) {
            // update
            const updateData: any = {
              security_guard_id: resolvedSecurityGuardId || null,
              site_tours: normalizeJsonField(data.siteTours || data.site_tours),
              tasks: normalizeJsonField(data.tasks),
              post_orders: normalizeJsonField(data.postOrders || data.post_orders),
              checklists: normalizeJsonField(data.checklists),
              skill_set: normalizeJsonField(data.skillSet || data.skill_set),
              department: normalizeJsonField(data.department),
              updatedAt: now,
            };

            if (hasStationColumn) {
              updateData.station_id = data.station || data.stationId || null;
            }

            const updateFields = Object.keys(updateData).map(key => `${key} = :${key}`).join(', ');
            await sequelize.query(
              `UPDATE tenant_user_post_sites SET ${updateFields} WHERE tenantUserId = :tenantUserId AND businessInfoId = :businessInfoId`,
              { replacements: { ...updateData, tenantUserId, businessInfoId: postSiteId }, transaction },
            );
          } else {
            // insert
            const { randomUUID } = await import('crypto');
            const row: any = {
              id: randomUUID(),
              tenantUserId,
              businessInfoId: postSiteId,
              security_guard_id: resolvedSecurityGuardId || null,
              site_tours: normalizeJsonField(data.siteTours || data.site_tours),
              tasks: normalizeJsonField(data.tasks),
              post_orders: normalizeJsonField(data.postOrders || data.post_orders),
              checklists: normalizeJsonField(data.checklists),
              skill_set: normalizeJsonField(data.skillSet || data.skill_set),
              department: normalizeJsonField(data.department),
              createdAt: now,
              updatedAt: now,
            };

            if (hasStationColumn) {
              row.station_id = data.station || data.stationId || null;
            }

            await sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', [row], { transaction });
          }
        }
      } catch (e) {
        // If pivot creation fails, log but do not block shift creation
        console.warn('ShiftService.create: failed to create/update tenant_user_post_sites pivot', e && (e as any).message || e);
      }

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
        'shift',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.station = await StationRepository.filterIdInTenant(data.station, { ...this.options, transaction });
      data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      data.postSite = await BusinessInfoRepository.filterIdInTenant(data.postSite, { ...this.options, transaction });
      try {
        data.tenantUserId = data.tenantUserId || data.tenantUser || null;
      } catch (e) {
        // ignore
      }

      const record = await ShiftRepository.update(
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
        'shift',
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
        await ShiftRepository.destroy(id, {
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
    return ShiftRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return ShiftRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return ShiftRepository.findAndCountAll(
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
    const count = await ShiftRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
