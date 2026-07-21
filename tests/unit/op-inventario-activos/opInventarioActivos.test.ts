/**
 * Unit tests — Inventario y activos (operación diaria).
 *
 * Complements the existing crud-g10-inventory + globalInventory suites, which
 * pin CREATE/UPDATE field-fidelity on the repositories. This suite covers the
 * GAPS that a security company hits every day and that were NOT yet exercised:
 *
 *   - stationOrder (consignas por puesto)  — FULL express CRUD handlers:
 *       create field-fidelity + postSiteId derived from station + whitelist,
 *       LIST scoped by tenant+station (isolation), partial UPDATE that must NOT
 *       clobber unsent fields, cross-tenant/cross-station guards, DELETE scope.
 *   - inventoryAssignment LIST (findAndCountAll) — tenant scope, filters
 *       (stationId / active), pagination (limit/offset with full count).
 *   - inventoryAssignment DESTROY business rule — freeing the item ONLY when the
 *       deleted assignment was the last active one for that item.
 *   - radioDevice LIST/GET/DESTROY handlers — tenant scope + filters, and the
 *       security invariant that the SIP password is NEVER serialized out.
 *   - guardDevice by-guard listing + resetGuardBinding — securityGuard→user
 *       resolution, tenant scope, push-token never leaked, bind/flag reset.
 *
 * Everything runs against a Sequelize-shaped in-memory fake db + sinon. No MySQL,
 * no network. Imports the REAL production repositories / services / handlers.
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json mocha \
 *     -r ts-node/register 'tests/unit/op-inventario-activos/**\/*.test.ts' \
 *     --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import InventoryAssignmentRepository from '../../../src/database/repositories/inventoryAssignmentRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import Error404 from '../../../src/errors/Error404';
import { encrypt } from '../../../src/lib/secretBox';
import { resetGuardBinding } from '../../../src/services/guardDeviceService';

import stationOrderRoutes from '../../../src/api/stationOrder';
import radioDeviceListHandler from '../../../src/api/radioDevice/list';
import radioDeviceGetHandler from '../../../src/api/radioDevice/get';
import radioDeviceDestroyHandler from '../../../src/api/radioDevice/destroy';
import guardDeviceByGuardHandler from '../../../src/api/guardDevice/guardDeviceByGuard';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
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

/** Where matcher supporting plain equality + Op.ne / Op.in. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (typeof key === 'symbol') continue;
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[key as string] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[key as string]))) return false;
        }
        continue;
      }
    }
    if (row[key as string] !== cond) return false;
  }
  return true;
}

function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return a < b ? -1 : 1;
}

function applyOrder(rows: any[], order: any[]): any[] {
  if (!order || !order.length) return rows;
  return [...rows].sort((r1, r2) => {
    for (const spec of order) {
      const field = Array.isArray(spec) ? spec[0] : spec;
      const dir = (Array.isArray(spec) ? spec[1] : 'ASC') || 'ASC';
      let c = cmp(r1[field], r2[field]);
      if (String(dir).toUpperCase() === 'DESC') c = -c;
      if (c !== 0) return c;
    }
    return 0;
  });
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      findAndCountAll: [] as any[],
      update: [] as any[],
      destroy: [] as any[],
      count: [] as any[],
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
      const matched = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return applyOrder(matched, q.order)[0] || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      let matched = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      matched = applyOrder(matched, q.order);
      if (typeof q.offset === 'number') matched = matched.slice(q.offset);
      if (typeof q.limit === 'number') matched = matched.slice(0, q.limit);
      return matched;
    },
    async findAndCountAll(q: any = {}) {
      model.calls.findAndCountAll.push(q);
      let matched = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      const count = matched.length;
      matched = applyOrder(matched, q.order);
      if (typeof q.offset === 'number') matched = matched.slice(q.offset);
      if (typeof q.limit === 'number') matched = matched.slice(0, q.limit);
      return { rows: matched, count };
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async update(values: any, q: any = {}) {
      model.calls.update.push({ values: { ...values }, where: q.where });
      const victims = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      victims.forEach((r: any) => {
        for (const [k, v] of Object.entries(values)) {
          if (v !== undefined) r[k] = v;
        }
      });
      return [victims.length];
    },
    async count(q: any = {}) {
      model.calls.count.push(q);
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

function buildDb(seed: any = {}) {
  const db: any = {
    stationOrder: makeModel('stationOrder', seed.stationOrders || []),
    stationOrderCompletion: makeModel('stationOrderCompletion', seed.stationOrderCompletions || []),
    station: makeModel('station', seed.stations || []),
    radioDevice: makeModel('radioDevice', seed.radioDevices || []),
    deviceIdInformation: makeModel('deviceIdInformation', seed.deviceIdInformations || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    user: makeModel('user', seed.users || []),
    inventoryItem: makeModel('inventoryItem', seed.inventoryItems || []),
    inventoryAssignment: makeModel('inventoryAssignment', seed.inventoryAssignments || []),
    sequelize: {
      __commits: 0,
      __rollbacks: 0,
      async transaction() {
        const s = db.sequelize;
        return {
          async commit() { s.__commits += 1; },
          async rollback() { s.__rollbacks += 1; },
        };
      },
    },
  };
  return db;
}

function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: adminUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

function fakeReq(db: any, extra: any = {}) {
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

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.send = (b: any) => { res.body = b; return res; };
  res.sendStatus = (c: number) => { res.statusCode = c; return res; };
  res.header = () => res;
  res.sendFile = () => res;
  return res;
}

/** Collect the express routes stationOrder registers into a callable map. */
function mountStationOrder() {
  const routes: Record<string, Function> = {};
  const app: any = {
    get: (path: string, fn: Function) => (routes[`GET ${path}`] = fn),
    post: (path: string, fn: Function) => (routes[`POST ${path}`] = fn),
    put: (path: string, fn: Function) => (routes[`PUT ${path}`] = fn),
    delete: (path: string, fn: Function) => (routes[`DELETE ${path}`] = fn),
  };
  stationOrderRoutes(app);
  return routes;
}

// Silence the audit side-channel used by the assignment repo.
// Wrapped in a parent describe so these hooks are NOT module-root-level — a
// root-level beforeEach/afterEach runs for EVERY test in the whole mocha run
// (all files) and its sinon.restore() clobbered other suites' stubs, failing
// their "before each" hooks when run together.
describe('op-inventario · activos (suite)', () => {
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
});
afterEach(() => sinon.restore());

// ═════════════════════ stationOrder (consignas por puesto) ══════════════════
const ORDER_FULL = {
  title: 'Ronda perimetral cada 2 horas',
  description: 'Recorrer el perímetro completo y registrar novedades',
  time: '22:00',
  recurrence: 'daily',
  days: '1,2,3,4,5',
  dayOfMonth: 15,
  date: '2026-08-01',
  priority: 'alta',
  active: true,
  notifyEnabled: true,
  notifyMinutesBefore: 10,
};

describe('op-inventario · stationOrder create handler', () => {
  const routes = mountStationOrder();
  const create = () => routes['POST /tenant/:tenantId/station/:stationId/orders'];

  it('persists EVERY whitelisted field, derives postSiteId from the station, stamps tenant/user', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT, postSiteId: 'ps-9' }] });
    const req = fakeReq(db, { params: { tenantId: TENANT, stationId: 'st-1' }, body: { data: { ...ORDER_FULL } } });
    const res = fakeRes();
    await create()(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.stationOrder.calls.create[0];
    for (const [k, v] of Object.entries(ORDER_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" dropped or altered on create`);
    }
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.postSiteId, 'ps-9', 'postSiteId not derived from the station');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('drops unknown / non-whitelisted fields (no mass-assignment)', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT, postSiteId: null }] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1' },
      body: { data: { ...ORDER_FULL, tenantId: OTHER_TENANT, id: 'forced-id', createdById: 'evil' } },
    });
    await create()(req, fakeRes());
    const written = db.stationOrder.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT, 'client-sent tenantId must not override the current tenant');
    assert.strictEqual(written.createdById, USER_ID, 'client-sent createdById must not be trusted');
    // postSiteId falls back to null when the station has none.
    assert.strictEqual(written.postSiteId, null);
  });
});

describe('op-inventario · stationOrder list handler (tenant + station scope)', () => {
  const routes = mountStationOrder();
  const list = () => routes['GET /tenant/:tenantId/station/:stationId/orders'];

  it('returns only the target station+tenant orders (no leak across station or tenant)', async () => {
    const db = buildDb({
      stationOrders: [
        { id: 'o1', tenantId: TENANT, stationId: 'st-1', title: 'mine A' },
        { id: 'o2', tenantId: TENANT, stationId: 'st-1', title: 'mine B' },
        { id: 'o3', tenantId: TENANT, stationId: 'st-2', title: 'other station' },
        { id: 'o4', tenantId: OTHER_TENANT, stationId: 'st-1', title: 'other tenant' },
      ],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, stationId: 'st-1' } });
    const res = fakeRes();
    await list()(req, res);

    assert.strictEqual(res.statusCode, 200);
    const ids = res.body.rows.map((r: any) => r.id).sort();
    assert.deepStrictEqual(ids, ['o1', 'o2'], 'list leaked orders from another station or tenant');
    assert.strictEqual(res.body.count, 2);
  });
});

describe('op-inventario · stationOrder update handler (partial, no null-clobber)', () => {
  const routes = mountStationOrder();
  const update = () => routes['PUT /tenant/:tenantId/station/:stationId/orders/:id'];

  const seed = () => ({ id: 'o1', tenantId: TENANT, stationId: 'st-1', postSiteId: 'ps-9', ...ORDER_FULL });

  it('a title-only edit persists the new title and leaves every other field intact', async () => {
    const db = buildDb({ stationOrders: [seed()] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1', id: 'o1' },
      body: { data: { title: 'Ronda cada hora (actualizada)' } },
    });
    const res = fakeRes();
    await update()(req, res);

    assert.strictEqual(res.statusCode, 200);
    const row = db.stationOrder.rows[0];
    assert.strictEqual(row.title, 'Ronda cada hora (actualizada)');
    // Nothing else may be wiped by the partial patch (classic null-clobber bug).
    assert.strictEqual(row.description, ORDER_FULL.description);
    assert.strictEqual(row.time, ORDER_FULL.time);
    assert.strictEqual(row.priority, ORDER_FULL.priority);
    assert.strictEqual(row.active, true);
    assert.strictEqual(row.notifyMinutesBefore, 10);
    // The applied patch only carried title + updatedById.
    const applied = row.__updateCalls[0];
    assert.deepStrictEqual(Object.keys(applied).sort(), ['title', 'updatedById']);
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('can toggle active=false without touching the rest', async () => {
    const db = buildDb({ stationOrders: [seed()] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1', id: 'o1' },
      body: { data: { active: false } },
    });
    await update()(req, fakeRes());
    const row = db.stationOrder.rows[0];
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.title, ORDER_FULL.title);
  });

  it('an order in ANOTHER tenant is not found and is NOT written', async () => {
    const db = buildDb({ stationOrders: [{ ...seed(), tenantId: OTHER_TENANT }] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1', id: 'o1' },
      body: { data: { title: 'hijack' } },
    });
    const res = fakeRes();
    await update()(req, res);
    assert.strictEqual(db.stationOrder.rows[0].__updateCalls.length, 0, 'cross-tenant write leaked');
    assert.strictEqual(res.body.success, false);
  });

  it('an order under a DIFFERENT station id is not found (station-scoped)', async () => {
    const db = buildDb({ stationOrders: [seed()] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-2', id: 'o1' },
      body: { data: { title: 'wrong station' } },
    });
    const res = fakeRes();
    await update()(req, res);
    assert.strictEqual(db.stationOrder.rows[0].__updateCalls.length, 0);
    assert.strictEqual(res.body.success, false);
  });
});

describe('op-inventario · stationOrder delete handler (tenant + station scope)', () => {
  const routes = mountStationOrder();
  const del = () => routes['DELETE /tenant/:tenantId/station/:stationId/orders/:id'];

  it('destroys the targeted order', async () => {
    const db = buildDb({ stationOrders: [{ id: 'o1', tenantId: TENANT, stationId: 'st-1', ...ORDER_FULL }] });
    const req = fakeReq(db, { params: { tenantId: TENANT, stationId: 'st-1', id: 'o1' } });
    const res = fakeRes();
    await del()(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.stationOrder.rows[0].__destroyed, true);
  });

  it('does NOT destroy an order belonging to another tenant', async () => {
    const db = buildDb({ stationOrders: [{ id: 'o1', tenantId: OTHER_TENANT, stationId: 'st-1', ...ORDER_FULL }] });
    const req = fakeReq(db, { params: { tenantId: TENANT, stationId: 'st-1', id: 'o1' } });
    await del()(req, fakeRes());
    assert.strictEqual(db.stationOrder.rows[0].__destroyed, false, 'cross-tenant order was destroyed');
  });
});

// ═════════════════════ inventoryAssignment LIST + DESTROY flow ═══════════════
const ITEM_FULL = {
  name: 'Radio Motorola EP450', type: 'radio', serialNumber: 'SN-1', condition: 'bueno', status: 'asignado',
};

describe('op-inventario · inventoryAssignment.findAndCountAll (list scope/filter/paging)', () => {
  const asg = (over: any = {}) => ({
    id: over.id || 'asg',
    tenantId: TENANT,
    inventoryItemId: 'item-1',
    stationId: 'st-1',
    postSiteId: 'ps-1',
    assignedToUserId: 'guard-7',
    assignedAt: '2026-07-14T08:00:00.000Z',
    returnedAt: null,
    ...over,
  });

  it('scopes to the current tenant (no cross-tenant rows)', async () => {
    const db = buildDb({
      inventoryAssignments: [
        asg({ id: 'a1' }),
        asg({ id: 'a2', tenantId: OTHER_TENANT }),
      ],
    });
    const { rows, count } = await InventoryAssignmentRepository.findAndCountAll({}, repoOptions(db));
    assert.strictEqual(count, 1);
    assert.deepStrictEqual(rows.map((r: any) => r.id), ['a1']);
  });

  it('filters by stationId and by active=true (only not-yet-returned)', async () => {
    const db = buildDb({
      inventoryAssignments: [
        asg({ id: 'a1', stationId: 'st-1', returnedAt: null }),
        asg({ id: 'a2', stationId: 'st-1', returnedAt: '2026-07-14T18:00:00.000Z' }),
        asg({ id: 'a3', stationId: 'st-2', returnedAt: null }),
      ],
    });
    const byStation = await InventoryAssignmentRepository.findAndCountAll({ filter: { stationId: 'st-1' } }, repoOptions(db));
    assert.deepStrictEqual(byStation.rows.map((r: any) => r.id).sort(), ['a1', 'a2']);

    const active = await InventoryAssignmentRepository.findAndCountAll({ filter: { active: 'true' } }, repoOptions(db));
    assert.deepStrictEqual(active.rows.map((r: any) => r.id).sort(), ['a1', 'a3'], 'active filter must exclude returned assignments');
  });

  it('paginates: count is the FULL total, rows are the page slice', async () => {
    const seeds = Array.from({ length: 5 }, (_, i) => asg({ id: `a${i}`, assignedAt: `2026-07-1${i}T08:00:00.000Z` }));
    const db = buildDb({ inventoryAssignments: seeds });
    const page = await InventoryAssignmentRepository.findAndCountAll(
      { limit: 2, offset: 2, orderBy: 'assignedAt_ASC' },
      repoOptions(db),
    );
    assert.strictEqual(page.count, 5, 'count must be the total, not the page size');
    assert.strictEqual(page.rows.length, 2);
    assert.deepStrictEqual(page.rows.map((r: any) => r.id), ['a2', 'a3']);
  });
});

describe('op-inventario · inventoryAssignment.destroy (frees item only when last active)', () => {
  it('when another ACTIVE assignment remains, the item stays "asignado"', async () => {
    const db = buildDb({
      inventoryAssignments: [
        { id: 'asg-1', tenantId: TENANT, inventoryItemId: 'item-1', returnedAt: null },
        { id: 'asg-2', tenantId: TENANT, inventoryItemId: 'item-1', returnedAt: null },
      ],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    await InventoryAssignmentRepository.destroy('asg-1', repoOptions(db));
    assert.strictEqual(db.inventoryAssignment.rows[0].__destroyed, true);
    assert.strictEqual(db.inventoryItem.rows[0].status, 'asignado', 'item wrongly freed while another active assignment exists');
  });

  it('when it was the LAST active assignment, the item is freed to "disponible"', async () => {
    const db = buildDb({
      inventoryAssignments: [{ id: 'asg-1', tenantId: TENANT, inventoryItemId: 'item-1', returnedAt: null }],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    await InventoryAssignmentRepository.destroy('asg-1', repoOptions(db));
    assert.strictEqual(db.inventoryItem.rows[0].status, 'disponible');
  });

  it('a returned (already historical) sibling does NOT count as active', async () => {
    const db = buildDb({
      inventoryAssignments: [
        { id: 'asg-1', tenantId: TENANT, inventoryItemId: 'item-1', returnedAt: null },
        { id: 'asg-2', tenantId: TENANT, inventoryItemId: 'item-1', returnedAt: '2026-07-01T00:00:00.000Z' },
      ],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    await InventoryAssignmentRepository.destroy('asg-1', repoOptions(db));
    assert.strictEqual(db.inventoryItem.rows[0].status, 'disponible', 'a returned sibling must not keep the item marked asignado');
  });

  it('destroying an assignment in ANOTHER tenant throws Error404 and writes nothing', async () => {
    const db = buildDb({
      inventoryAssignments: [{ id: 'asg-1', tenantId: OTHER_TENANT, inventoryItemId: 'item-1', returnedAt: null }],
      inventoryItems: [{ id: 'item-1', tenantId: OTHER_TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    await assert.rejects(() => InventoryAssignmentRepository.destroy('asg-1', repoOptions(db)), Error404);
    assert.strictEqual(db.inventoryAssignment.rows[0].__destroyed, false);
  });
});

// ═════════════════════ radioDevice list / get / destroy handlers ════════════
const RADIO_SEED = (over: any = {}) => ({
  id: over.id || 'rd-1',
  tenantId: TENANT,
  name: 'Gateway RoIP',
  host: '10.0.0.50',
  sipUsername: 'roip-user',
  sipPassword: encrypt('super-secret-pass'),
  stationId: 'st-1',
  postSiteId: 'ps-1',
  active: true,
  status: 'registered',
  createdAt: '2026-07-10T00:00:00.000Z',
  ...over,
});

describe('op-inventario · radioDevice list handler', () => {
  it('scopes to tenant and NEVER serializes the SIP password (only configured + last4)', async () => {
    const db = buildDb({
      radioDevices: [
        RADIO_SEED({ id: 'rd-1' }),
        RADIO_SEED({ id: 'rd-2', tenantId: OTHER_TENANT }),
      ],
    });
    const req = fakeReq(db, { query: {} });
    const res = fakeRes();
    await radioDeviceListHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 1, 'radio devices leaked across tenant');
    const dev = res.body.rows[0];
    assert.strictEqual(dev.id, 'rd-1');
    assert.strictEqual(dev.sipPassword, undefined, 'SIP password leaked in list payload');
    assert.strictEqual(dev.sipPasswordConfigured, true);
    assert.strictEqual(dev.sipPasswordLast4, 'pass');
  });

  it('filters by stationId and by active flag', async () => {
    const db = buildDb({
      radioDevices: [
        RADIO_SEED({ id: 'rd-1', stationId: 'st-1', active: true }),
        RADIO_SEED({ id: 'rd-2', stationId: 'st-2', active: true }),
        RADIO_SEED({ id: 'rd-3', stationId: 'st-1', active: false }),
      ],
    });
    let res = fakeRes();
    await radioDeviceListHandler(fakeReq(db, { query: { stationId: 'st-1' } }), res);
    assert.deepStrictEqual(res.body.rows.map((r: any) => r.id).sort(), ['rd-1', 'rd-3']);

    res = fakeRes();
    await radioDeviceListHandler(fakeReq(db, { query: { active: 'false' } }), res);
    assert.deepStrictEqual(res.body.rows.map((r: any) => r.id), ['rd-3']);
  });
});

describe('op-inventario · radioDevice get + destroy handlers', () => {
  it('get returns the scoped device without the raw password', async () => {
    const db = buildDb({ radioDevices: [RADIO_SEED({ id: 'rd-1' })] });
    const res = fakeRes();
    await radioDeviceGetHandler(fakeReq(db, { params: { id: 'rd-1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, 'rd-1');
    assert.strictEqual(res.body.sipPassword, undefined);
    assert.strictEqual(res.body.sipPasswordConfigured, true);
  });

  it('get on a device of ANOTHER tenant returns 404', async () => {
    const db = buildDb({ radioDevices: [RADIO_SEED({ id: 'rd-1', tenantId: OTHER_TENANT })] });
    const res = fakeRes();
    await radioDeviceGetHandler(fakeReq(db, { params: { id: 'rd-1' } }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('destroy soft-deletes the device; a cross-tenant destroy returns 404 and writes nothing', async () => {
    const db = buildDb({
      radioDevices: [
        RADIO_SEED({ id: 'rd-1' }),
        RADIO_SEED({ id: 'rd-9', tenantId: OTHER_TENANT }),
      ],
    });
    let res = fakeRes();
    await radioDeviceDestroyHandler(fakeReq(db, { params: { id: 'rd-1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.radioDevice.rows[0].__destroyed, true);

    res = fakeRes();
    await radioDeviceDestroyHandler(fakeReq(db, { params: { id: 'rd-9' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.radioDevice.rows[1].__destroyed, false, 'cross-tenant device destroyed');
  });
});

// ═════════════════════ guardDevice by-guard + resetGuardBinding ══════════════
describe('op-inventario · guardDevice by-guard listing', () => {
  const dev = (over: any = {}) => ({
    id: over.id || 'd1',
    tenantId: TENANT,
    userId: 'guard-user-1',
    deviceId: 'dev-aaa',
    platform: 'android',
    model: 'Pixel 7',
    isBound: false,
    flagged: false,
    pushToken: 'FCM-SECRET-TOKEN',
    lastSeenAt: '2026-07-10T00:00:00.000Z',
    ...over,
  });

  it('resolves securityGuard id → user id, scopes by tenant, and never leaks the push token', async () => {
    const db = buildDb({
      securityGuards: [{ id: 'sg-1', tenantId: TENANT, guardId: 'guard-user-1' }],
      deviceIdInformations: [
        dev({ id: 'd1', isBound: true, lastSeenAt: '2026-07-11T00:00:00.000Z' }),
        dev({ id: 'd2', deviceId: 'dev-bbb', flagged: true, lastSeenAt: '2026-07-09T00:00:00.000Z' }),
        dev({ id: 'd3', userId: 'other-guard' }),          // different guard
        dev({ id: 'd4', tenantId: OTHER_TENANT }),          // different tenant
      ],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, userId: 'sg-1' } });
    const res = fakeRes();
    await guardDeviceByGuardHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 2, 'listing leaked another guard/tenant or missed the resolution');
    const ids = res.body.rows.map((r: any) => r.id);
    // Bound device is ordered first.
    assert.strictEqual(ids[0], 'd1', 'bound device must sort first');
    // Push token must never be serialized — only a boolean.
    for (const r of res.body.rows) {
      assert.strictEqual(r.pushToken, undefined, 'raw push token leaked to the admin device list');
    }
    const bound = res.body.rows.find((r: any) => r.id === 'd1');
    assert.strictEqual(bound.hasPush, true);
    assert.strictEqual(bound.isBound, true);
  });

  it('falls back to treating the param as a user id when no securityGuard matches', async () => {
    const db = buildDb({
      securityGuards: [],
      deviceIdInformations: [dev({ id: 'd1', userId: 'guard-user-1' })],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, userId: 'guard-user-1' } });
    const res = fakeRes();
    await guardDeviceByGuardHandler(req, res);
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.rows[0].id, 'd1');
  });
});

describe('op-inventario · resetGuardBinding service', () => {
  it('unbinds and clears the flag on ALL of the guard\'s devices (tenant + user scoped)', async () => {
    const db = buildDb({
      deviceIdInformations: [
        { id: 'd1', tenantId: TENANT, userId: 'guard-user-1', isBound: true, flagged: false },
        { id: 'd2', tenantId: TENANT, userId: 'guard-user-1', isBound: false, flagged: true },
        { id: 'd3', tenantId: TENANT, userId: 'other-guard', isBound: true, flagged: false },
        { id: 'd4', tenantId: OTHER_TENANT, userId: 'guard-user-1', isBound: true, flagged: false },
      ],
    });
    const result = await resetGuardBinding(db, TENANT, 'd1', USER_ID);
    assert.strictEqual(result.userId, 'guard-user-1');
    assert.strictEqual(result.cleared, 2, 'should clear exactly this guard-in-this-tenant devices');

    assert.strictEqual(db.deviceIdInformation.rows[0].isBound, false);
    assert.strictEqual(db.deviceIdInformation.rows[1].flagged, false);
    // Other guard + other tenant untouched.
    assert.strictEqual(db.deviceIdInformation.rows[2].isBound, true, 'another guard was wrongly reset');
    assert.strictEqual(db.deviceIdInformation.rows[3].isBound, true, 'another tenant was wrongly reset');
  });

  it('a device id from ANOTHER tenant resolves to nothing (no cross-tenant reset)', async () => {
    const db = buildDb({
      deviceIdInformations: [
        { id: 'd1', tenantId: OTHER_TENANT, userId: 'guard-user-1', isBound: true, flagged: true },
      ],
    });
    const result = await resetGuardBinding(db, TENANT, 'd1', USER_ID);
    assert.deepStrictEqual(result, { userId: null, cleared: 0 });
    assert.strictEqual(db.deviceIdInformation.rows[0].isBound, true, 'cross-tenant device was reset');
  });
});

});
