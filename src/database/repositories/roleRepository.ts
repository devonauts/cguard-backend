import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import SequelizeArrayUtils from '../utils/sequelizeArrayUtils';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import Roles from '../../security/roles';
import Sequelize from 'sequelize';
import lodash from 'lodash';
import {
  ADMIN_FLOOR_PERMISSIONS,
  FLOOR_ROLE_SLUGS,
  getStaticDefaultsForRole,
} from '../../security/staticRolePermissions';
const cache = new Map();
// Permission cache eviction. Without this the Map kept ONE entry per tenant for
// the lifetime of the process (entries were only overwritten on re-fetch, never
// removed), so it grew with the tenant count and never released — a slow leak on
// a hot path. Drop entries not read in 10 min (the next request re-fetches), and
// hard-cap the size. The sweep timer is unref'd so it never keeps the worker up.
const ROLE_CACHE_IDLE_EVICT_MS = 10 * 60 * 1000;
const ROLE_CACHE_MAX = 10000;
const _roleCacheSweep = setInterval(() => {
  const cutoff = Date.now() - ROLE_CACHE_IDLE_EVICT_MS;
  for (const [k, v] of cache) {
    if (((v && v.lastAccess) || 0) < cutoff) cache.delete(k);
  }
}, 5 * 60 * 1000);
if (_roleCacheSweep && typeof (_roleCacheSweep as any).unref === 'function') (_roleCacheSweep as any).unref();
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
      cached.lastAccess = now;
      return cached.value;
    }

    const db = options && options.database;
    if (!db) {
      throw new Error('Options with database is required');
    }

    const rows = await db.role.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['slug', 'permissions', 'isCustomized'],
    });

    const map = {};
    const customized: string[] = [];
    rows.forEach((r) => {
      try {
        const perms = r.permissions || [];
        map[r.slug] = Array.isArray(perms) ? perms : JSON.parse(perms || '[]');
      } catch (e) {
        map[r.slug] = [];
      }
      if (r.isCustomized) customized.push(r.slug);
    });

    // cache for 30 seconds (map + the set of customized slugs)
    cache.set(cacheKey, { value: map, customized, expires: now + 30 * 1000, lastAccess: now });

    // Hard cap: if we somehow exceed the limit, evict the least-recently-read.
    if (cache.size > ROLE_CACHE_MAX) {
      const entries = [...cache.entries()].sort(
        (a, b) => ((a[1] && a[1].lastAccess) || 0) - ((b[1] && b[1].lastAccess) || 0),
      );
      for (let i = 0; i < entries.length - ROLE_CACHE_MAX; i++) cache.delete(entries[i][0]);
    }

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
    if (cached) cached.lastAccess = Date.now();
    return (cached && cached.value) ? cached.value : {};
  }

  // Returns the set of role slugs the tenant has customized (synchronous). Lets
  // the checker treat an emptied custom/system role as authoritative-empty.
  static getCachedCustomizedSlugsForTenant(tenantId): Set<string> {
    if (!tenantId) return new Set();
    const cacheKey = `role_permissions_map:${tenantId}`;
    const cached = cache.get(cacheKey);
    if (cached) cached.lastAccess = Date.now();
    return new Set((cached && cached.customized) || []);
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

  // Roles that remain FULLY locked (permissions not tenant-editable, never
  // deletable). All other built-ins are now editable per tenant.
  //  - superadmin: global platform role, not a per-tenant role.
  //  - customer: external client access; its permission surface is fixed.
  static getFullyLockedRoleSlugs() {
    return [Roles.values.superadmin, Roles.values.customer].map((s) =>
      String(s).toLowerCase(),
    );
  }

  static isFullyLockedRole(slug) {
    if (typeof slug !== 'string') return false;
    return this.getFullyLockedRoleSlugs().includes(slug.toLowerCase());
  }

  // Back-compat alias — some callers still reference the old name. Now maps to
  // the narrowed "fully locked" set (superadmin/customer only).
  static isProtectedDefaultRole(slug) {
    return this.isFullyLockedRole(slug);
  }

  // Apply the admin floor: the floor permissions can never be removed from the
  // admin role, so a tenant can't lock itself out of role/user management.
  static applyAdminFloor(slug, permissions) {
    const perms = Array.isArray(permissions) ? permissions.slice() : [];
    if (FLOOR_ROLE_SLUGS.includes(String(slug).toLowerCase())) {
      for (const p of ADMIN_FLOOR_PERMISSIONS) {
        if (!perms.includes(p)) perms.push(p);
      }
    }
    return perms;
  }

  static async update(id, data, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.role.findByPk(id, { transaction });
    if (!record) {
      throw new Error404();
    }

    if (this.isFullyLockedRole(record.slug)) {
      throw new Error400(options.language, 'entities.role.errors.lockedDefaultRole');
    }

    // System rows: only permissions/name/description are editable — never the
    // slug (identity) or isSystem. Custom rows may change slug.
    const editable = record.isSystem
      ? ['name', 'description', 'permissions']
      : ['name', 'slug', 'description', 'permissions'];
    const patch: any = { ...lodash.pick(data, editable), updatedById: currentUser.id };

    if (typeof patch.permissions !== 'undefined') {
      // Force-union the admin floor so it can never be removed from the admin role.
      patch.permissions = this.applyAdminFloor(record.slug, patch.permissions);
      // Mark system roles as customized once their permissions are edited so the
      // checker treats the DB set as authoritative (even if emptied) and "reset
      // to default" becomes available.
      if (record.isSystem) patch.isCustomized = true;
    }

    await record.update(patch, { transaction });

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

  // Reset a SYSTEM role's permissions back to its static defaults (undo
  // customization). Only valid for built-in/system rows.
  static async resetToDefault(id, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    const record = await options.database.role.findByPk(id, { transaction });
    if (!record) {
      throw new Error404();
    }
    if (!record.isSystem) {
      throw new Error400(options.language, 'entities.role.errors.notSystemRole');
    }

    const defaults = this.applyAdminFloor(record.slug, getStaticDefaultsForRole(record.slug));

    await record.update(
      { permissions: defaults, isCustomized: false, updatedById: currentUser.id },
      { transaction },
    );

    await AuditLogRepository.log(
      {
        entityName: 'role',
        entityId: record.id,
        action: AuditLogRepository.UPDATE,
        values: { ...record.get({ plain: true }), _resetToDefault: true },
      },
      options,
    );

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

    // System roles are editable but never deletable; custom roles can be removed.
    if (record.isSystem || this.isFullyLockedRole(record.slug)) {
      throw new Error400(options.language, 'entities.role.errors.lockedDefaultRole');
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
