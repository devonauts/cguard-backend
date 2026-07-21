/**
 * Unit tests — routeRun API (vehicle-patrol daily completion board).
 *
 * The supervisor board marks a route "done for today". Endpoints under test are
 * the REAL express handlers from src/api/routeRun/index.ts against a Sequelize-
 * shaped in-memory fake db (no MySQL, no network):
 *
 *   GET    /route-runs?date=          list runs for a day (tenant-scoped)
 *   POST   /route/:routeId/run        UPSERT a run (idempotent per tenant+route+date)
 *   DELETE /route/:routeId/run?date=  undo (remove the run)
 *
 * These endpoints are NOT covered by the existing crud-g07 / patrols-rondas
 * suites (which cover patrol/siteTour/tag-scan/rondaSettings), so this extends
 * coverage into the vehicle-patrol run tracking.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rondas-patrullaje/routeRun.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import routeRunRoutes from '../../../src/api/routeRun';

const TENANT = 'tenant-A';
const OTHER = 'tenant-B';
const USER_ID = 'user-1';

// ─────────────────────────── fake db (Sequelize-shaped) ──────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    __destroyed: false,
    __destroyCalls: [] as any[],
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (k.startsWith('__') || typeof row[k] === 'function') continue;
        plain[k] = row[k];
      }
      return opts && opts.plain ? { ...plain } : plain;
    },
    async update(patch: any) {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
      return row;
    },
    async destroy(opts?: any) {
      row.__destroyed = true;
      row.__destroyCalls.push(opts || {});
      return row;
    },
  };
  return row;
}

const matches = (row: any, where: any) =>
  !where || Object.keys(where).every((k) => row[k] === where[k]);

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    rows: seed.map(makeRow),
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[] },
    async create(data: any) {
      model.calls.create.push({ ...data });
      const r = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data });
      model.rows.push(r);
      return r;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => !r.__destroyed && matches(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && matches(r, q.where));
    },
  };
  return model;
}

function buildDb(seed: { routeRuns?: any[] } = {}) {
  return {
    routeRun: makeModel('run', seed.routeRuns || []),
    // tenantToday would query this if no date is passed; we always pass date.
    tenant: makeModel('tenant', [{ id: TENANT, timezone: 'America/Guayaquil' }]),
  } as any;
}

function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    fullName: 'Ana Admin',
    email: 'admin@test.ec',
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
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
  return res;
}

function captureRoutes(registrar: (r: any) => void) {
  const routes: Record<string, Function> = {};
  const cap = (m: string) => (p: string, h: Function) => { routes[`${m} ${p}`] = h; };
  registrar({ get: cap('GET'), post: cap('POST'), put: cap('PUT'), delete: cap('DELETE') });
  return routes;
}

describe('op-rondas · routeRun — daily completion board', () => {
  const routes = captureRoutes(routeRunRoutes);
  const LIST = routes['GET /tenant/:tenantId/route-runs'];
  const POST = routes['POST /tenant/:tenantId/route/:routeId/run'];
  const DEL = routes['DELETE /tenant/:tenantId/route/:routeId/run'];

  afterEach(() => sinon.restore());

  // ── POST upsert ───────────────────────────────────────────────────────────
  it('POST creates a run stamping completedById + completedByName + date + tenant', async () => {
    const db = buildDb();
    const res = fakeRes();
    await POST(fakeReq(db, {
      params: { routeId: 'route-9' },
      body: { data: { date: '2026-07-20', note: 'todo ok' } },
    }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.routeRun.calls.create.length, 1);
    const created = db.routeRun.calls.create[0];
    assert.strictEqual(created.routeId, 'route-9');
    assert.strictEqual(created.tenantId, TENANT);
    assert.strictEqual(created.date, '2026-07-20');
    assert.strictEqual(created.status, 'completed');
    assert.strictEqual(created.note, 'todo ok');
    assert.strictEqual(created.completedById, USER_ID);
    assert.strictEqual(created.completedByName, 'Ana Admin');
    assert.ok(created.completedAt instanceof Date);
  });

  it('POST is idempotent — a second run for the same tenant+route+date UPDATES, never duplicates', async () => {
    const db = buildDb({
      routeRuns: [{
        id: 'run-1', tenantId: TENANT, routeId: 'route-9', date: '2026-07-20',
        status: 'completed', note: 'primera', completedById: USER_ID, completedByName: 'Ana Admin',
      }],
    });
    const res = fakeRes();
    await POST(fakeReq(db, {
      params: { routeId: 'route-9' },
      body: { data: { date: '2026-07-20', note: 'corregida' } },
    }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.routeRun.calls.create.length, 0, 'must not insert a duplicate');
    assert.strictEqual(db.routeRun.rows.length, 1);
    assert.strictEqual(db.routeRun.rows[0].note, 'corregida', 'existing run updated in place');
  });

  it('POST for a DIFFERENT date creates a separate run (per-day tracking)', async () => {
    const db = buildDb({
      routeRuns: [{ id: 'run-1', tenantId: TENANT, routeId: 'route-9', date: '2026-07-19', status: 'completed' }],
    });
    const res = fakeRes();
    await POST(fakeReq(db, { params: { routeId: 'route-9' }, body: { data: { date: '2026-07-20' } } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.routeRun.calls.create.length, 1, 'a new day → a new run');
    assert.strictEqual(db.routeRun.rows.length, 2);
  });

  // ── GET list ────────────────────────────────────────────────────────────────
  it('GET lists only the current tenant runs (never another tenant) and filters by date', async () => {
    const db = buildDb({
      routeRuns: [
        { id: 'r1', tenantId: TENANT, routeId: 'route-1', date: '2026-07-20', completedAt: new Date('2026-07-20T10:00:00Z') },
        { id: 'r2', tenantId: TENANT, routeId: 'route-2', date: '2026-07-19', completedAt: new Date('2026-07-19T10:00:00Z') },
        { id: 'r3', tenantId: OTHER, routeId: 'route-3', date: '2026-07-20', completedAt: new Date('2026-07-20T11:00:00Z') },
      ],
    });
    const res = fakeRes();
    await LIST(fakeReq(db, { query: { date: '2026-07-20' } }), res);

    assert.strictEqual(res.statusCode, 200);
    const ids = res.body.rows.map((r: any) => r.id).sort();
    assert.deepStrictEqual(ids, ['r1'], 'only tenant-A run on that date; foreign tenant excluded');
    assert.strictEqual(res.body.count, 1);
  });

  it('GET without a date returns every run for the tenant', async () => {
    const db = buildDb({
      routeRuns: [
        { id: 'r1', tenantId: TENANT, routeId: 'route-1', date: '2026-07-20' },
        { id: 'r2', tenantId: TENANT, routeId: 'route-2', date: '2026-07-19' },
        { id: 'r3', tenantId: OTHER, routeId: 'route-3', date: '2026-07-20' },
      ],
    });
    const res = fakeRes();
    await LIST(fakeReq(db, { query: {} }), res);
    assert.strictEqual(res.body.count, 2);
  });

  // ── DELETE undo ──────────────────────────────────────────────────────────────
  it('DELETE removes the tenant run for that route+date (force destroy)', async () => {
    const db = buildDb({
      routeRuns: [{ id: 'run-1', tenantId: TENANT, routeId: 'route-9', date: '2026-07-20' }],
    });
    const res = fakeRes();
    await DEL(fakeReq(db, { params: { routeId: 'route-9' }, query: { date: '2026-07-20' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.routeRun.rows[0].__destroyed, true);
    assert.strictEqual(db.routeRun.rows[0].__destroyCalls[0].force, true, 'hard delete so the day can be re-marked');
  });

  it("DELETE does NOT remove another tenant's run for the same route+date", async () => {
    const db = buildDb({
      routeRuns: [{ id: 'run-b', tenantId: OTHER, routeId: 'route-9', date: '2026-07-20' }],
    });
    const res = fakeRes();
    await DEL(fakeReq(db, { params: { routeId: 'route-9' }, query: { date: '2026-07-20' } }), res);
    assert.strictEqual(res.statusCode, 200, 'idempotent no-op success');
    assert.strictEqual(db.routeRun.rows[0].__destroyed, false, 'foreign run survives');
  });

  // ── permission gate ──────────────────────────────────────────────────────────
  it('POST is rejected (403) when the user lacks patrolCreate', async () => {
    const db = buildDb();
    const req = fakeReq(db, {
      params: { routeId: 'route-9' },
      body: { data: { date: '2026-07-20' } },
      currentUser: { id: 'u2', email: 'x@y.z', emailVerified: true, tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['customer'] }] },
    });
    const res = fakeRes();
    await POST(req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.routeRun.calls.create.length, 0);
  });
});
