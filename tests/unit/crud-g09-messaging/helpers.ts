/**
 * Shared fake-db harness for the crud-g09-messaging tests.
 *
 * Mirrors tests/unit/crud-g01-clients: a tiny in-memory Sequelize-shaped db —
 * makeRow rows with get/update/destroy that RECORD their calls, model objects
 * with create/findOne/findAll/findOrCreate/update/destroy that record calls.
 * No MySQL, no network.
 */
import Sequelize from 'sequelize';

const Op = Sequelize.Op;

export const TENANT = 'tenant-A';
export const OTHER_TENANT = 'tenant-B';
export const USER_ID = 'user-1';

// ──────────────────────── makeRow (Sequelize-shaped) ─────────────────────────
export function makeRow(data: any) {
  const row: any = {
    deletedAt: null,
    ...data,
    __updateCalls: [] as any[],
    __setDeviceIdCalls: [] as any[],
    __destroyed: false,
    get(opts?: any) {
      if (typeof opts === 'string') return row[opts];
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (k.startsWith('__') || typeof row[k] === 'function') continue;
        plain[k] = row[k];
      }
      return opts && opts.plain ? { ...plain } : plain;
    },
    async update(patch: any) {
      row.__updateCalls.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) row[k] = v;
      }
      return row;
    },
    async save() {
      return row;
    },
    async reload() {
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      row.deletedAt = new Date();
      return row;
    },
    // notification M2M + file relation getters used by findById fill.
    async setDeviceId(ids: any) {
      row.__setDeviceIdCalls.push(ids);
      row.__deviceIds = ids;
      return row;
    },
    async getDeviceId() {
      return row.__deviceIds || [];
    },
    async getImageUrl() {
      return null;
    },
  };
  return row;
}

/** Where matcher: plain equality + Op.and / Op.or / Op.in / Op.ne / Op.gte / Op.lte. */
export function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (key === Op.or) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.some((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (typeof key === 'symbol') continue; // other top-level operators unused
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[key as string] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[key as string]))) return false;
          if (s === Op.gte && !(new Date(row[key as string]).getTime() >= new Date(v as any).getTime())) return false;
          if (s === Op.lte && !(new Date(row[key as string]).getTime() <= new Date(v as any).getTime())) return false;
          if (s === Op.lt && !(new Date(row[key as string]).getTime() < new Date(v as any).getTime())) return false;
          if (s === Op.gt && !(new Date(row[key as string]).getTime() > new Date(v as any).getTime())) return false;
        }
        continue;
      }
    }
    if (row[key as string] !== cond) return false;
  }
  return true;
}

export function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      destroy: [] as any[],
      update: [] as any[],
      findOrCreate: [] as any[],
    },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data });
      row.createdAt = row.createdAt || new Date();
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      const paranoid = q.paranoid !== false;
      return (
        model.rows.find(
          (r: any) => (!paranoid || (!r.__destroyed && !r.deletedAt)) && matchWhere(r, q.where),
        ) || null
      );
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && !r.deletedAt && matchWhere(r, q.where));
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async findOrCreate(q: any = {}) {
      model.calls.findOrCreate.push(q);
      const existing = model.rows.find((r: any) => !r.__destroyed && !r.deletedAt && matchWhere(r, q.where));
      if (existing) return [existing, false];
      const row = await model.create({ ...(q.defaults || {}), ...(q.where || {}) });
      return [row, true];
    },
    // Static (bulk) update — returns [affectedCount] like Sequelize.
    async update(patch: any, q: any = {}) {
      model.calls.update.push({ patch: { ...patch }, where: q.where });
      const victims = model.rows.filter((r: any) => !r.__destroyed && !r.deletedAt && matchWhere(r, q.where));
      for (const r of victims) {
        for (const [k, v] of Object.entries(patch)) r[k] = v;
      }
      return [victims.length];
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q);
      const victims = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      victims.forEach((r: any) => {
        r.__destroyed = true;
        r.deletedAt = new Date();
      });
      return victims.length;
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => !r.__destroyed && !r.deletedAt && matchWhere(r, q.where)).length;
    },
  };
  return model;
}

/** Fake transaction whose commit/rollback is observable. */
export function makeTx() {
  const tx: any = {
    committed: false,
    rolledBack: false,
    LOCK: { UPDATE: 'UPDATE' },
    async commit() {
      tx.committed = true;
    },
    async rollback() {
      tx.rolledBack = true;
    },
  };
  return tx;
}

/** Repository/service options (SequelizeRepository-shaped). */
export function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

// Admin req context (passes PermissionChecker on the free plan; the shadow
// enforceGate never blocks with RBAC_ENFORCE_NEW_GATES off).
export function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

export function fakeReq(db: any, extra: any = {}) {
  return {
    currentUser: adminUser(),
    currentTenant: { id: TENANT },
    language: 'es',
    database: db,
    params: {},
    body: {},
    query: {},
    ...extra,
  } as any;
}

export function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: any) => {
    res.body = b;
    return res;
  };
  res.send = (b: any) => {
    res.body = b;
    return res;
  };
  res.sendStatus = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.end = () => res;
  res.header = () => res;
  return res;
}

/** Wait until fire-and-forget microtasks settle. */
export const flush = () => new Promise((r) => setImmediate(r));
