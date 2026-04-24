import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import { IRepositoryOptions } from './IRepositoryOptions';
import UserRepository from './userRepository';
import VehicleRepository from './vehicleRepository';

class RouteRepository {
  static async create(data: any, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    // Resolve tenantId robustly: prefer currentTenant, fallback to route params or headers
    let tenantId = tenant && tenant.id ? tenant.id : null;
    const optAny: any = options as any;
    if (!tenantId && optAny && optAny.params && optAny.params.tenantId) {
      tenantId = optAny.params.tenantId;
    }
    if (!tenantId && optAny && optAny.headers) {
      const headers = optAny.headers;
      tenantId = headers['x-tenant-id'] || headers['X-Tenant-Id'] || tenantId;
    }
    // As a last resort, try to parse tenantId from the originalUrl (e.g. /api/tenant/:tenantId/...)
    if (!tenantId && optAny && optAny.originalUrl) {
      try {
        const m = String(optAny.originalUrl).match(/\/tenant\/([0-9a-fA-F-]{36})\//);
        if (m && m[1]) {
          tenantId = m[1];
        }
      } catch (e) {
        // ignore
      }
    }
    if (!tenantId) {
      throw new Error400(options && options.language, 'tenantNotFound');
    }
    const transaction = SequelizeRepository.getTransaction(options);

    const createData = {
      name: data.name,
      description: data.description || null,
      continuous: data.continuous !== undefined ? data.continuous : true,
      windowStart: data.windowStart || null,
      windowEnd: data.windowEnd || null,
      days: data.days || null,
      assignedGuard: data.assignedGuard || null,
      vehicleId: data.vehicleId || null,
      syncHitsBetweenGuards: !!data.syncHitsBetweenGuards,
      forceVehicleRouteOrder: !!data.forceVehicleRouteOrder,
      notifyBefore: data.notifyBefore || null,
      autoCheckInByGeofence: !!data.autoCheckInByGeofence,
      forceCheckInBeforeStart: !!data.forceCheckInBeforeStart,
      tenantId,
      createdById: currentUser ? currentUser.id : null,
      updatedById: currentUser ? currentUser.id : null,
    };

    // Debug: log resolved tenantId and a light options summary before DB insert
    try {
      console.log('RouteRepository.create -> resolved tenantId:', tenantId);
      // show whether options.currentTenant exists and whether params contain tenantId
      console.log('RouteRepository.create -> options.currentTenant?.id:', SequelizeRepository.getCurrentTenant(options) ? SequelizeRepository.getCurrentTenant(options).id : null);
      console.log('RouteRepository.create -> options.params?.tenantId:', optAny && optAny.params ? optAny.params.tenantId : null);
      console.log('RouteRepository.create -> options.originalUrl:', optAny && optAny.originalUrl ? optAny.originalUrl : null);
    } catch (e) {
      console.warn('RouteRepository.create - logging failed', String((e as any)?.message || e));
    }

    const record = await options.database.route.create(createData, { transaction });

    if (Array.isArray(data.points) && data.points.length) {
      const points = data.points.map((p: any, idx: number) => ({
        routeId: record.id,
        siteId: p.siteId,
        order: p.order ?? idx + 1,
        duration: p.duration || null,
        scheduledHits: p.scheduledHits || 1,
        address: p.address || null,
        lat: p.lat || null,
        lng: p.lng || null,
      }));

      await options.database.routePoint.bulkCreate(points, { transaction });
    }

    try {
      await AuditLogRepository.log({ entityName: 'route', entityId: record.id, action: AuditLogRepository.CREATE, values: createData }, options);
    } catch (e) {
      // ignore audit log errors
    }

    return this.findById(record.id, options);
  }

  static async findById(id: string, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.route.findOne({ where: { id, tenantId: currentTenant.id }, transaction, include: [{ model: options.database.routePoint, as: 'points' }] });

    if (!record) {
      throw new Error404();
    }

    const plain = record.get({ plain: true });
    if (plain.points) {
      plain.points = plain.points.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
    }

    return plain;
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    const ids = await this.filterIdsInTenant([id], options);
    return ids && ids.length ? ids[0] : null;
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const where = {
      id: ids,
      tenantId: currentTenant.id,
    };

    const records = await options.database.route.findAll({ attributes: ['id'], where });
    return records.map((r) => r.id);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.route.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        name: data.name,
        description: data.description || null,
        continuous: data.continuous !== undefined ? data.continuous : record.continuous,
        windowStart: data.windowStart || null,
        windowEnd: data.windowEnd || null,
        days: data.days || null,
        assignedGuard: data.assignedGuard || null,
        vehicleId: data.vehicleId || null,
        syncHitsBetweenGuards: !!data.syncHitsBetweenGuards,
        forceVehicleRouteOrder: !!data.forceVehicleRouteOrder,
        notifyBefore: data.notifyBefore || null,
        autoCheckInByGeofence: !!data.autoCheckInByGeofence,
        forceCheckInBeforeStart: !!data.forceCheckInBeforeStart,
        updatedById: currentUser ? currentUser.id : null,
      },
      { transaction },
    );

    // Replace points: simple approach - delete existing points and bulkCreate new ones
    if (data.points) {
      await options.database.routePoint.destroy({ where: { routeId: id }, transaction });
      const points = data.points.map((p: any, idx: number) => ({
        routeId: id,
        siteId: p.siteId,
        order: p.order ?? idx + 1,
        duration: p.duration || null,
        scheduledHits: p.scheduledHits || 1,
        address: p.address || null,
        lat: p.lat || null,
        lng: p.lng || null,
      }));
      if (points.length) {
        await options.database.routePoint.bulkCreate(points, { transaction });
      }
    }

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.route.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    return options.database.route.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: any = [];
    whereAnd.push({ tenantId: tenant.id });

    if (filter) {
      if (filter.id) {
        whereAnd.push({ id: filter.id });
      }
      if (filter.name) {
        whereAnd.push({ name: { [require('sequelize').Op.like]: `%${filter.name}%` } });
      }
    }

    const where = { [require('sequelize').Op.and]: whereAnd };

    const { rows, count } = await options.database.route.findAndCountAll({ where, include: [{ model: options.database.routePoint, as: 'points' }], limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']], transaction: SequelizeRepository.getTransaction(options) });

    const filledRows = await this._fillWithRelationsAndFilesForRows(rows, options);

    return { rows: filledRows, count };
  }

  static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
    if (!rows) return rows;
    return Promise.all(rows.map((r) => this._fillWithRelationsAndFiles(r, options)));
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) return record;
    const output = record.get ? record.get({ plain: true }) : record;

    // Resolve assignedGuard if present (fetch user summary)
    try {
      if (output.assignedGuard) {
        // attempt to fetch user details; fall back to original id on failure
        try {
          const user = await UserRepository.findById(output.assignedGuard, options);
          output.assignedGuard = UserRepository.cleanupForRelationships(user);
        } catch (e) {
          // leave assignedGuard as-is (id)
        }
      }
    } catch (e) {
      // ignore
    }

    // Resolve vehicle if present
    try {
      if (output.vehicleId) {
        try {
          const vehicle = await VehicleRepository.findById(output.vehicleId, options);
          output.vehicle = vehicle;
        } catch (e) {
          // leave vehicle undefined
        }
      }
    } catch (e) {
      // ignore
    }

    // Resolve points' site names when possible
    try {
      if (output.points && Array.isArray(output.points)) {
        const transaction = SequelizeRepository.getTransaction(options);
        for (const p of output.points) {
          try {
            if (p && p.siteId) {
              const site = await options.database.businessInfo.findByPk(p.siteId, { transaction });
              if (site) {
                p.siteName = site.companyName || site.name || null;
              }
            }
          } catch (e) {
            // ignore per-point failures
          }
        }
      }
    } catch (e) {
      // ignore
    }

    return output;
  }

  static async findAllAutocomplete(search, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    const where = { tenantId: tenant.id };
    if (search) {
      where['name'] = { [require('sequelize').Op.like]: `%${search}%` };
    }

    const records = await options.database.route.findAll({ attributes: ['id', 'name'], where, limit: limit ? Number(limit) : undefined, order: [['name', 'ASC']] });

    return records.map((r) => ({ id: r.id, label: r.name }));
  }

  static async _createAuditLog(action, record, data, options) {
    try {
      let values = {};
      if (data) {
        values = { ...record.get ? record.get({ plain: true }) : record };
      }

      await AuditLogRepository.log({ entityName: 'route', entityId: record.id, action, values }, options);
    } catch (e) {
      // ignore
    }
  }
}

export default RouteRepository;
