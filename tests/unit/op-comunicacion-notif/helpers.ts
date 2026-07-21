/**
 * Shared in-memory, Sequelize-shaped fake db + request/response fakes for the
 * comunicación & notificaciones suite. No MySQL, no network. Mirrors the shape
 * used by tests/unit/crud-g06-incidents/crudIncidents.test.ts.
 */
import Sequelize from 'sequelize';

export const Op = Sequelize.Op;

export const TENANT = 'tenant-A';
export const OTHER_TENANT = 'tenant-B';
export const ADMIN_USER_ID = 'user-admin-1';

// Valid UUIDs — memos filter runs through SequelizeFilterUtils.uuid(), which
// replaces any NON-uuid value with a random one (breaking equality matching).
export const SG_A = '11111111-1111-4111-8111-111111111111'; // guard A securityGuard.id
export const SG_B = '22222222-2222-4222-8222-222222222222'; // guard B securityGuard.id
export const GUARD_A_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const GUARD_B_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MEMO_A1 = '33333333-3333-4333-8333-333333333331';
export const MEMO_A2 = '33333333-3333-4333-8333-333333333332';
export const MEMO_B1 = '33333333-3333-4333-8333-33333333333b';

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
    // memos.findById signs this file relation.
    async getMemoDocumentPdf() {
      return row.__memoDocumentPdf || null;
    },
  };
  return row;
}

/** Where matcher supporting plain equality + Op.and / Op.ne / Op.in / Op.gte / Op.lte.
 *  Unknown operator symbols (Op.or, Op.like) are ignored (treated as pass) so a
 *  coarse SQL pre-filter doesn't drop rows the JS layer re-checks. */
export function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (typeof key === 'symbol') continue; // Op.or / Op.like pre-filters: ignore
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[key as string] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[key as string]))) return false;
          if (s === Op.gte && !(row[key as string] >= v)) return false;
          if (s === Op.lte && !(row[key as string] <= v)) return false;
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
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[], destroy: [] as any[] },
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
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => !r.__destroyed && r.id === id) || null;
    },
    async findAndCountAll(q: any = {}) {
      model.calls.findAll.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      const count = rows.length;
      if (q.offset) rows = rows.slice(q.offset);
      if (q.limit) rows = rows.slice(0, q.limit);
      return { rows, count };
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where)).length;
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

export interface SeedShape {
  memos?: any[];
  securityGuards?: any[];
  users?: any[];
  tenants?: any[];
  tenantUsers?: any[];
  settings?: any[];
}

export function buildDb(seed: SeedShape = {}) {
  const queryCalls: any[] = [];
  return {
    __queryCalls: queryCalls,
    memos: makeModel('memo', seed.memos || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    user: makeModel('user', seed.users || []),
    tenant: makeModel('tenant', seed.tenants || []),
    tenantUser: makeModel('tenantUser', seed.tenantUsers || []),
    businessInfo: makeModel('businessInfo', []),
    settings: makeModel('setting', seed.settings || []),
    sequelize: {
      async transaction() {
        return { LOCK: { UPDATE: 'UPDATE' }, async commit() {}, async rollback() {} };
      },
      async query(sql: any, opts: any) {
        queryCalls.push({ sql: String(sql), opts });
        return [[], []];
      },
    },
  } as any;
}

/** currentUser holding admin (CRM) — passes memosCreate/memosRead + PermissionChecker. */
export function adminUser(tenantId = TENANT) {
  return {
    id: ADMIN_USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

/** currentUser holding ONLY the guard role — lacks memosCreate (SUPERVISOR_ROLES),
 *  passes memosRead (ALL_STAFF_ROLES). */
export function guardUser(userId: string, tenantId = TENANT) {
  return {
    id: userId,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['securityGuard'] }],
  };
}

export function options(db: any, currentUser: any, tenantId = TENANT) {
  return { currentUser, currentTenant: { id: tenantId }, language: 'es', database: db } as any;
}

export function fakeReq(db: any, currentUser: any, extra: any = {}) {
  return {
    currentUser,
    currentTenant: { id: TENANT },
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
  const res: any = { statusCode: 200, body: undefined, headers: {} };
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
