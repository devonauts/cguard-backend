/**
 * Shared Sequelize-shaped in-memory fake db for the op-incidentes-eventos suite.
 *
 * Mirrors the shape used by crud-g06-incidents/crudIncidents.test.ts but extends
 * the where-matcher with Op.gte/lte/gt/lt (the alarm ingest pipeline correlates
 * signals/cases by time windows) and adds a real `count` + `findOrCreate` (the
 * incident-type lazy seeder relies on both), plus a capturing `sequelize.query`
 * so platform-event fan-out (raw INSERT into platform_events) is observable.
 *
 * NO MySQL, NO network — pure in-memory.
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
    async save() {
      row.__updateCalls.push({ __save: true });
      return row;
    },
    async reload() {
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    // Association getters used by incident._fillWithRelationsAndFiles.
    async getImageUrl() {
      return null;
    },
    async getIncidentType() {
      return null;
    },
    async getClient() {
      return null;
    },
    async getSite() {
      return null;
    },
    async getStation() {
      return null;
    },
    async getGuardName() {
      return null;
    },
  };
  return row;
}

function cmp(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/** Where matcher: plain equality + Op.ne/in/and/or/gte/lte/gt/lt. */
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
    if (
      cond !== null &&
      typeof cond === 'object' &&
      !Array.isArray(cond) &&
      !(cond instanceof Date)
    ) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        const rv = row[key as string];
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && rv === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(rv))) return false;
          if (s === Op.notIn && Array.isArray(v) && v.includes(rv)) return false;
          if (s === Op.gte && !(rv != null && cmp(rv, v) >= 0)) return false;
          if (s === Op.lte && !(rv != null && cmp(rv, v) <= 0)) return false;
          if (s === Op.gt && !(rv != null && cmp(rv, v) > 0)) return false;
          if (s === Op.lt && !(rv != null && cmp(rv, v) < 0)) return false;
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
      findOrCreate: [] as any[],
    },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({
        id: data.id || `${name}-${model.rows.length + 1}`,
        createdAt: data.createdAt || new Date(),
        deletedAt: null,
        ...data,
      });
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      const list = model.rows.filter(
        (r: any) => !r.__destroyed && matchWhere(r, q.where),
      );
      return list[0] || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async findAndCountAll(q: any = {}) {
      const rows = model.rows.filter(
        (r: any) => !r.__destroyed && matchWhere(r, q.where),
      );
      return { rows, count: rows.length };
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => {
        if (r.__destroyed) return false;
        if (!matchWhere(r, q.where)) return false;
        // paranoid:false counts soft-deleted rows too; default excludes them.
        if (q.paranoid === false) return true;
        return r.deletedAt == null;
      }).length;
    },
    async findOrCreate(q: any = {}) {
      model.calls.findOrCreate.push(q);
      const existing = model.rows.find(
        (r: any) => !r.__destroyed && matchWhere(r, q.where),
      );
      if (existing) return [existing, false];
      const created = await model.create({ ...(q.defaults || {}) });
      return [created, true];
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

export function buildDb(seed: any = {}) {
  const queries: any[] = [];
  const db: any = {
    incident: makeModel('incident', seed.incidents || []),
    incidentType: makeModel('incidentType', seed.incidentTypes || []),
    kpi: makeModel('kpi', seed.kpis || []),
    station: makeModel('station', seed.stations || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    guardShift: makeModel('guardShift', seed.guardShifts || []),
    tenant: makeModel('tenant', seed.tenants || []),
    tenantUser: makeModel('tenantUser', seed.tenantUsers || []),
    user: makeModel('user', seed.users || []),
    file: makeModel('file', seed.files || []),
    report: makeModel('report', []),
    alarmPanel: makeModel('alarmPanel', seed.alarmPanels || []),
    alarmContact: makeModel('alarmContact', seed.alarmContacts || []),
    alarmZone: makeModel('alarmZone', seed.alarmZones || []),
    alarmCase: makeModel('alarmCase', seed.alarmCases || []),
    alarmSignal: makeModel('alarmSignal', seed.alarmSignals || []),
    alarmEvent: makeModel('alarmEvent', seed.alarmEvents || []),
    alarmDispatch: makeModel('alarmDispatch', seed.alarmDispatches || []),
    alarmAuditLog: makeModel('alarmAuditLog', seed.alarmAuditLogs || []),
    videoClip: makeModel('videoClip', seed.videoClips || []),
    securityAuditLog: makeModel('securityAuditLog', seed.securityAuditLogs || []),
    Sequelize,
    __queries: queries,
    sequelize: {
      transaction: async () => ({ commit: async () => {}, rollback: async () => {} }),
      async query(sql: string, opts: any = {}) {
        queries.push({ sql, opts });
        // Platform-event INSERTs and generic writes: just acknowledge.
        if (/count/i.test(sql)) return [[{ count: seed.inUseCount || 0 }]];
        return [[], {}];
      },
    },
  };
  return db;
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

export function fakeReq(db: any, extra: any = {}) {
  return {
    currentUser: adminUser(),
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

/**
 * Stub a method, first restoring any pre-existing stub. Defends against other
 * suites that (per the exemplar) install ROOT-level beforeEach stubs on the same
 * shared singleton (e.g. AuditLogRepository.log) — without this, a combined run
 * throws "Attempted to wrap X which is already wrapped".
 */
export function safeStub(sinon: any, obj: any, method: string) {
  if (obj[method] && obj[method].restore && obj[method].restore.sinon) {
    obj[method].restore();
  }
  return sinon.stub(obj, method);
}

/** Flush fire-and-forget IIFEs (best-effort push/comms fan-out). */
export async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}
