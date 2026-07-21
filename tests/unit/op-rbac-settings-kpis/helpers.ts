/**
 * Shared Sequelize-shaped fake-db + req/res doubles for the
 * op-rbac-settings-kpis suite (RBAC, settings, dashboard/KPIs, guardRating,
 * ronda settings, department settings). No MySQL, no network — the REAL
 * production repositories/services/handlers run against this in-memory db.
 *
 * NOTE (hooks): this file exports helpers only; it declares NO mocha hooks.
 * Each *.test.ts installs its own describe-scoped beforeEach/afterEach so the
 * combined run stays isolated.
 */

import Sequelize from 'sequelize';

export const Op = Sequelize.Op;

// ──────────────────────── makeRow (Sequelize-shaped) ─────────────────────────
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
    // Association getters used by SettingsRepository._fillWithRelationsAndFiles.
    async getLogos() {
      return [];
    },
    async getBackgroundImages() {
      return [];
    },
    async getLegalDocuments() {
      return [];
    },
  };
  return row;
}

/** where matcher: equality, arrays→IN, null, Op.and/or/ne/in/gte/lte/gt/lt. */
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
    if (typeof key === 'symbol') continue;
    const field = key as string;
    const actual = row[field];

    if (Array.isArray(cond)) {
      if (!cond.map(String).includes(String(actual))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && actual === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.map(String).includes(String(actual)))) return false;
          if (s === Op.gte && !(toCmp(actual) >= toCmp(v))) return false;
          if (s === Op.lte && !(toCmp(actual) <= toCmp(v))) return false;
          if (s === Op.gt && !(toCmp(actual) > toCmp(v))) return false;
          if (s === Op.lt && !(toCmp(actual) < toCmp(v))) return false;
        }
        continue;
      }
    }
    if (String(actual) !== String(cond) && !(actual == null && cond == null)) {
      if (actual !== cond) return false;
    }
  }
  return true;
}

function toCmp(v: any): number {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

export function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      findOrCreate: [] as any[],
      destroy: [] as any[],
      count: [] as any[],
      update: [] as any[],
    },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data, deletedAt: data.deletedAt ?? null });
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (q.limit) rows = rows.slice(0, Number(q.limit));
      return rows;
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => !r.__destroyed && String(r.id) === String(id)) || null;
    },
    async findAndCountAll(q: any = {}) {
      const all = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      const rows = q.limit ? all.slice(Number(q.offset) || 0, (Number(q.offset) || 0) + Number(q.limit)) : all;
      return { rows, count: all.length };
    },
    async count(q: any = {}) {
      model.calls.count.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where)).length;
    },
    async findOrCreate(q: any = {}) {
      model.calls.findOrCreate.push(q);
      const found = model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (found) return [found, false];
      const created = await model.create({ ...(q.defaults || {}) });
      return [created, true];
    },
    async update(patch: any, q: any = {}) {
      model.calls.update.push({ patch, q });
      const victims = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, (q || {}).where));
      victims.forEach((r: any) => {
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) r[k] = v;
      });
      return [victims.length];
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

const MODEL_NAMES = [
  'role', 'tenantUser', 'user', 'tenant', 'settings', 'file',
  'guardRating', 'securityGuard', 'clientAccount', 'station', 'businessInfo',
  'rondaSettings', 'department', 'incident', 'task', 'tagScan', 'billing',
  'guardShift', 'report',
];

export function buildDb(seed: Record<string, any[]> = {}) {
  const db: any = { Sequelize };
  MODEL_NAMES.forEach((n) => (db[n] = makeModel(n, seed[n] || [])));
  db.sequelize = {
    Sequelize,
    async transaction() {
      return { commit: async () => {}, rollback: async () => {} };
    },
    // Aggregate helpers used by dashboardService (values are opaque markers here;
    // the dashboard tests that need real aggregation stub the model.findAll).
    fn: (name: string, colRef: any) => ({ __fn: name, col: colRef }),
    col: (c: string) => ({ __col: c }),
  };
  return db;
}

// ──────────────────────── req/res + options doubles ─────────────────────────
export function userWithRoles(roles: string[], tenantId: string, extra: any = {}) {
  return {
    id: extra.id || 'user-1',
    emailVerified: true,
    ...extra,
    tenants: [
      {
        tenant: { id: tenantId },
        status: 'active',
        roles,
        permissions: extra.permissions,
        permissionOverrides: extra.permissionOverrides,
        assignedClients: extra.assignedClients,
        assignedPostSites: extra.assignedPostSites,
      },
    ],
  };
}

export function adminUser(tenantId: string) {
  return userWithRoles(['admin'], tenantId);
}

export function repoOptions(db: any, tenantId: string, user?: any) {
  return {
    currentUser: user || adminUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

export function fakeReq(db: any, tenantId: string, extra: any = {}) {
  return {
    currentUser: extra.currentUser || adminUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
    params: {},
    body: {},
    query: {},
    headers: {},
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
  res.header = () => res;
  return res;
}
