/**
 * Shared Sequelize-shaped fake db for the op-turnos-pasedeturno suite.
 * In-memory only (no MySQL, no network). NOT a *.test.ts file, so mocha's glob
 * never runs it as a spec — it is imported by the spec files.
 */
import Sequelize from 'sequelize';

export const Op = Sequelize.Op;

export const TENANT = 'tenant-A';
export const OTHER_TENANT = 'tenant-B';
export const USER_ID = 'user-1';

export function makeRow(data: any) {
  const row: any = {
    ...data,
    __updateCalls: [] as any[],
    __destroyed: false,
    get(opts?: any) {
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
    async reload() {
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
  };
  return row;
}

/** Where matcher supporting equality + Op.ne/in/gte/gt/lte/lt + Op.and. */
export function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (typeof key === 'symbol') continue;
    const col = key as string;
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          const rv = row[col];
          if (s === Op.ne && rv === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(rv))) return false;
          if (s === Op.gte && !(rv != null && new Date(rv).getTime() >= new Date(v).getTime())) return false;
          if (s === Op.gt && !(rv != null && new Date(rv).getTime() > new Date(v).getTime())) return false;
          if (s === Op.lte && !(rv != null && new Date(rv).getTime() <= new Date(v).getTime())) return false;
          if (s === Op.lt && !(rv != null && new Date(rv).getTime() < new Date(v).getTime())) return false;
        }
        continue;
      }
    }
    // Array value → treat as IN (Sequelize shorthand, used by shift.destroy).
    if (Array.isArray(cond)) {
      if (!cond.includes(row[col])) return false;
      continue;
    }
    if (row[col] !== cond) return false;
  }
  return true;
}

function applyOrder(rows: any[], order: any): any[] {
  if (!order || !order.length) return rows;
  const [col, dir] = order[0];
  const sign = String(dir).toUpperCase() === 'DESC' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    const at = av instanceof Date ? av.getTime() : new Date(av).getTime();
    const bt = bv instanceof Date ? bv.getTime() : new Date(bv).getTime();
    if (!isNaN(at) && !isNaN(bt)) return (at - bt) * sign;
    return (av < bv ? -1 : av > bv ? 1 : 0) * sign;
  });
}

export function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      findAndCountAll: [] as any[],
      findOrCreate: [] as any[],
      destroy: [] as any[],
    },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data, deletedAt: null });
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (q.order) rows = applyOrder(rows, q.order);
      return rows[0] || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (q.order) rows = applyOrder(rows, q.order);
      return rows;
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async findAndCountAll(q: any = {}) {
      model.calls.findAndCountAll.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (q.order) rows = applyOrder(rows, q.order);
      const count = rows.length;
      const offset = q.offset ? Number(q.offset) : 0;
      if (q.limit != null || offset) rows = rows.slice(offset, offset + (q.limit != null ? Number(q.limit) : rows.length));
      return { rows, count };
    },
    async findOrCreate(q: any = {}) {
      model.calls.findOrCreate.push(q);
      const found = model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (found) return [found, false];
      const row = makeRow({ id: `${name}-${model.rows.length + 1}`, ...(q.defaults || {}), deletedAt: null });
      model.rows.push(row);
      return [row, true];
    },
    async count() {
      return 0;
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q);
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      victims.forEach((r: any) => (r.__destroyed = true));
      return victims.length;
    },
  };
  return model;
}

export function buildTransaction() {
  const state = { committed: false, rolledBack: false };
  const tx: any = {
    __state: state,
    async commit() {
      state.committed = true;
    },
    async rollback() {
      state.rolledBack = true;
    },
  };
  return tx;
}

export function buildDb(seed: Record<string, any[]> = {}, extra: Record<string, any> = {}) {
  const models: Record<string, any> = {};
  const modelNames = [
    'shiftPassdown',
    'task',
    'file',
    'shift',
    'shiftExchangeRequest',
    'scheduleOverride',
    'tenant',
    'user',
    'station',
    'auditLog',
  ];
  for (const n of modelNames) models[n] = makeModel(n, seed[n] || []);

  const txHistory: any[] = [];
  const queryCalls: any[] = [];
  return {
    ...models,
    ...extra,
    Sequelize,
    sequelize: {
      __txHistory: txHistory,
      __queryCalls: queryCalls,
      async transaction() {
        const tx = buildTransaction();
        txHistory.push(tx);
        return tx;
      },
      async query(sql: any, opts: any) {
        queryCalls.push({ sql, opts });
        return [[], []];
      },
    },
  } as any;
}

export function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

export function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: adminUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}
