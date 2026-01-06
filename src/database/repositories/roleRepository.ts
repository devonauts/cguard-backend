import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import SequelizeArrayUtils from '../utils/sequelizeArrayUtils';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import lodash from 'lodash';
const cache = new Map();
  const Op = Sequelize.Op;

  function slugify(text) {
  if (!text) return null;
  return String(text)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  }

export default class RoleRepository {
    // Returns a map { roleSlug: [permissionIds] } for a tenant.
  // Uses an in-memory cache to avoid frequent DB hits on hot paths.
  static async getPermissionsMapForTenant(tenantId, options) {
    if (!tenantId) return {};

    const cacheKey = `role_permissions_map:${tenantId}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > now) {
      return cached.value;
    }

    const db = options && options.database;
    if (!db) {
      throw new Error('Options with database is required');
    }

    const rows = await db.role.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['slug', 'permissions'],
    });

    const map = {};
    rows.forEach((r) => {
      try {
        const perms = r.permissions || [];
        map[r.slug] = Array.isArray(perms) ? perms : JSON.parse(perms || '[]');
      } catch (e) {
        map[r.slug] = [];
      }
    });

    // cache for 30 seconds
    cache.set(cacheKey, { value: map, expires: now + 30 * 1000 });

    return map;
  }

  static clearCacheForTenant(tenantId) {
    const cacheKey = `role_permissions_map:${tenantId}`;
    cache.delete(cacheKey);
  }

  // Returns the cached permissions map for a tenant synchronously if present.
  // Useful for runtime permission checks that must remain synchronous.
  static getCachedPermissionsMapForTenant(tenantId) {
    if (!tenantId) return {};
    const cacheKey = `role_permissions_map:${tenantId}`;
    const cached = cache.get(cacheKey);
    return (cached && cached.value) ? cached.value : {};
  }

  static async create(data, options) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const payload = { ...lodash.pick(data, ['name', 'slug', 'description', 'permissions']) };
    if (!payload.slug) {
      payload.slug = slugify(payload.name) || null;
    }

    const record = await options.database.role.create(
      {
        ...payload,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await AuditLogRepository.log(
      {
        entityName: 'role',
        entityId: record.id,
        action: AuditLogRepository.CREATE,
        values: { ...record.get({ plain: true }) },
      },
      options,
    );

    // Clear cache so subsequent permission checks pick up the new role
    if (tenant && tenant.id) {
      this.clearCacheForTenant(tenant.id);
    }

    return this.findById(record.id, options);
  }

  static async update(id, data, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.role.findByPk(id, { transaction });
    if (!record) {
      throw new Error404();
    }

    await record.update({
      ...lodash.pick(data, ['name', 'slug', 'description', 'permissions']),
      updatedById: currentUser.id,
    }, { transaction });

    await AuditLogRepository.log(
      {
        entityName: 'role',
        entityId: record.id,
        action: AuditLogRepository.UPDATE,
        values: { ...record.get({ plain: true }) },
      },
      options,
    );

    // Clear cache for tenant
    if (tenant && tenant.id) {
      this.clearCacheForTenant(tenant.id);
    }

    return this.findById(record.id, options);
  }

  static async destroy(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);

    let record = await options.database.role.findByPk(id, { transaction });
    if (!record) {
      throw new Error404();
    }

    // Prevent deleting a role that is currently assigned to any tenantUser in the same tenant
    const tenant = SequelizeRepository.getCurrentTenant(options);
    try {
      const used = await options.database.tenantUser.findOne({
        where: {
          tenantId: tenant.id,
          ...SequelizeArrayUtils.filter('tenantUser', 'roles', record.slug),
        },
        transaction,
      });

      if (used) {
        throw new Error400(options.language, 'entities.role.errors.inUse');
      }
    } catch (e) {
      if (e instanceof Error400) throw e;
      // if DB doesn't support the operation or another error occurred, continue to attempt delete
    }

    await record.destroy({ transaction });

    await AuditLogRepository.log(
      {
        entityName: 'role',
        entityId: record.id,
        action: AuditLogRepository.DELETE,
        values: { id: record.id },
      },
      options,
    );

    // Clear cache for tenant
    if (tenant && tenant.id) {
      this.clearCacheForTenant(tenant.id);
    }
  }

  static async findById(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    let record = await options.database.role.findByPk(id, { transaction });
    if (!record) {
      throw new Error404();
    }
    return record;
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: any[] = [];
    if (filter) {
      if (filter.id) {
        whereAnd.push({ id: filter.id });
      }
      if (filter.name) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('role', 'name', filter.name));
      }
      if (filter.slug) {
        whereAnd.push({ slug: filter.slug });
      }
    }

    whereAnd.push({ tenantId: tenant.id });

    const where = { [Op.and]: whereAnd };

    const { rows, count } = await options.database.role.findAndCountAll({
      where,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['name', 'ASC']],
      transaction,
    });

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: any[] = [{ tenantId: tenant.id }];
    if (query) {
      whereAnd.push({ [Op.or]: [{ id: SequelizeFilterUtils.uuid(query) }, SequelizeFilterUtils.ilikeIncludes('role', 'name', query), SequelizeFilterUtils.ilikeIncludes('role', 'slug', query)] });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.role.findAll({
      attributes: ['id', 'name', 'slug'],
      where,
      limit: limit ? Number(limit) : undefined,
      order: [['name', 'ASC']],
    });

    return records.map((r) => ({ id: r.id, label: r.name }));
  }
}
