/**
 * CRUD persistence tests — route (Patrulla vehicular · RouteRepository) and the
 * routeRun daily-completion handlers.
 *
 * "Things are not being saved" net: every writable field of the route form must
 * reach the INSERT/UPDATE, points must be persisted with all their columns,
 * updates must target {id, tenantId}, partial patches must not wipe stored
 * values, and db failures must propagate (not 200).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g05-scheduling/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import RouteRepository from '../../../src/database/repositories/routeRepository';
import routeRunRoutes from '../../../src/api/routeRun';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-admin-1';

// Superadmin + tenant-admin: passes PermissionChecker so handler tests exercise
// the WRITE logic, not the ACL.
const ADMIN_USER = {
  id: USER_ID,
  email: 'admin@test.dev',
  fullName: 'Admin Uno',
  emailVerified: true,
  isSuperadmin: true,
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

// ── Sequelize-shaped fakes ───────────────────────────────────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    _updates: [] as any[],
    _destroyed: false,
    get(opts?: any) {
      void opts;
      return { ...data };
    },
    async update(patch: any) {
      row._updates.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue; // Sequelize skips undefined keys
        data[k] = v;
        row[k] = v;
      }
      return row;
    },
    async destroy(o?: any) {
      void o;
      row._destroyed = true;
    },
  };
  return row;
}

function buildDb(seed: { routes?: any[]; routeRuns?: any[] } = {}) {
  const routeRows = (seed.routes || []).map(makeRow);
  const runRows = (seed.routeRuns || []).map(makeRow);
  const calls: any = {
    routeCreate: [],
    routeFindOne: [],
    pointBulkCreate: [],
    pointDestroy: [],
    runCreate: [],
    audits: [],
  };

  const db: any = {
    routeRows,
    runRows,
    calls,
    Sequelize: require('sequelize'),
    route: {
      async create(payload: any) {
        calls.routeCreate.push({ ...payload });
        const row = makeRow({ id: `r-new-${calls.routeCreate.length}`, ...payload });
        routeRows.push(row);
        return row;
      },
      async findOne({ where }: any) {
        calls.routeFindOne.push({ ...where });
        return (
          routeRows.find(
            (r: any) =>
              (where.id === undefined || r.id === where.id) &&
              (where.tenantId === undefined || r.tenantId === where.tenantId),
          ) || null
        );
      },
    },
    routePoint: {
      async bulkCreate(rows: any[]) {
        calls.pointBulkCreate.push(rows.map((r) => ({ ...r })));
        return rows;
      },
      async destroy({ where }: any) {
        calls.pointDestroy.push({ ...where });
        return 0;
      },
    },
    routeRun: {
      async create(payload: any) {
        calls.runCreate.push({ ...payload });
        const row = makeRow({ id: `run-new-${calls.runCreate.length}`, ...payload });
        runRows.push(row);
        return row;
      },
      async findOne({ where }: any) {
        return (
          runRows.find(
            (r: any) =>
              (where.tenantId === undefined || r.tenantId === where.tenantId) &&
              (where.routeId === undefined || r.routeId === where.routeId) &&
              (where.date === undefined || r.date === where.date),
          ) || null
        );
      },
      async findAll() {
        return runRows;
      },
    },
    businessInfo: { async findOne() { return null; } },
    auditLog: {
      async create(entry: any) {
        calls.audits.push(entry);
        return makeRow({ id: `audit-${calls.audits.length}`, ...entry });
      },
    },
  };
  return db;
}

function options(db: any) {
  return {
    language: 'en',
    currentUser: ADMIN_USER,
    currentTenant: { id: TENANT },
    database: db,
  } as any;
}

/** Every writable field of the route form (incl. per-stop points). */
function fullPayload() {
  return {
    name: 'Ronda Norte',
    description: 'Recorrido nocturno por el sector norte',
    continuous: false,
    windowStart: new Date('2026-08-01T00:00:00Z'),
    windowEnd: new Date('2026-08-01T06:00:00Z'),
    days: ['mon', 'tue', 'wed'],
    assignedGuard: 'user-g1',
    vehicleId: 'veh-1',
    syncHitsBetweenGuards: true,
    forceVehicleRouteOrder: true,
    notifyBefore: '30m',
    autoCheckInByGeofence: true,
    forceCheckInBeforeStart: true,
    createPatrol: false, // skip the optional patrol side-flow
    points: [
      {
        siteId: 'site-1',
        order: 1,
        duration: 10,
        scheduledHits: 2,
        address: 'Av. Occidental 100',
        lat: -0.15,
        lng: -78.48,
        siteType: 'client',
        tasks: [{ id: 't1', label: 'Verificar portón' }],
      },
      { siteId: 'site-2' },
    ],
  };
}

describe('crud-g05 · route repository', () => {
  describe('create — field fidelity', () => {
    it('persists EVERY writable route field with the exact value the caller sent', async () => {
      const db = buildDb();
      const data = fullPayload();

      await RouteRepository.create(data, options(db));

      assert.strictEqual(db.calls.routeCreate.length, 1, 'exactly one route INSERT');
      const p = db.calls.routeCreate[0];
      assert.strictEqual(p.name, 'Ronda Norte');
      assert.strictEqual(p.description, data.description);
      assert.strictEqual(p.continuous, false, 'explicit continuous:false must persist (not default true)');
      assert.strictEqual(p.windowStart, data.windowStart);
      assert.strictEqual(p.windowEnd, data.windowEnd);
      assert.deepStrictEqual(p.days, ['mon', 'tue', 'wed']);
      assert.strictEqual(p.assignedGuard, 'user-g1');
      assert.strictEqual(p.vehicleId, 'veh-1');
      assert.strictEqual(p.syncHitsBetweenGuards, true);
      assert.strictEqual(p.forceVehicleRouteOrder, true);
      assert.strictEqual(p.notifyBefore, '30m');
      assert.strictEqual(p.autoCheckInByGeofence, true);
      assert.strictEqual(p.forceCheckInBeforeStart, true);
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);
    });

    it('persists the route points with their core columns (siteId/order/duration/hits/address/coords)', async () => {
      const db = buildDb();
      await RouteRepository.create(fullPayload(), options(db));

      assert.strictEqual(db.calls.pointBulkCreate.length, 1, 'points must be bulk-inserted');
      const [p1, p2] = db.calls.pointBulkCreate[0];
      assert.strictEqual(p1.routeId, db.routeRows[0].id);
      assert.strictEqual(p1.siteId, 'site-1');
      assert.strictEqual(p1.order, 1);
      assert.strictEqual(p1.duration, 10);
      assert.strictEqual(p1.scheduledHits, 2);
      assert.strictEqual(p1.address, 'Av. Occidental 100');
      assert.strictEqual(p1.lat, -0.15);
      assert.strictEqual(p1.lng, -78.48);
      // Defaults for a bare point:
      assert.strictEqual(p2.siteId, 'site-2');
      assert.strictEqual(p2.order, 2, 'order defaults to its index + 1');
      assert.strictEqual(p2.scheduledHits, 1);
      assert.strictEqual(p2.duration, null);
    });

    // FIXED: RouteRepository.create's point mapping now carries `siteType` and
    // `tasks` through to route_points (the routePoint model declares both and
    // the supervisor app consumes them for stop resolution + checklists).
    it('persists the per-stop siteType and tasks (checklist) columns', async () => {
      const db = buildDb();
      await RouteRepository.create(fullPayload(), options(db));
      const [p1] = db.calls.pointBulkCreate[0];
      assert.strictEqual(p1.siteType, 'client', 'siteType must reach route_points (stop resolution depends on it)');
      assert.deepStrictEqual(p1.tasks, [{ id: 't1', label: 'Verificar portón' }], 'per-stop checklist must be persisted');
    });

    it('does NOT swallow a db failure into a success (INSERT error propagates)', async () => {
      const db = buildDb();
      db.route.create = async () => {
        throw new Error('ER_NO_SUCH_TABLE: routes');
      };
      await assert.rejects(
        () => RouteRepository.create(fullPayload(), options(db)),
        /ER_NO_SUCH_TABLE/,
      );
    });
  });

  describe('update — targets the right row and applies the whole patch', () => {
    function seedRow(overrides: any = {}) {
      return {
        id: 'r-1',
        tenantId: TENANT,
        name: 'Ronda Norte',
        description: 'Descripción original',
        continuous: true,
        windowStart: new Date('2026-08-01T00:00:00Z'),
        windowEnd: new Date('2026-08-01T06:00:00Z'),
        days: ['mon'],
        assignedGuard: 'user-g1',
        vehicleId: 'veh-1',
        syncHitsBetweenGuards: true,
        forceVehicleRouteOrder: true,
        notifyBefore: '30m',
        autoCheckInByGeofence: true,
        forceCheckInBeforeStart: true,
        ...overrides,
      };
    }

    it('looks the row up by id AND tenantId (tenant-scoped where)', async () => {
      const db = buildDb({ routes: [seedRow()] });
      await RouteRepository.update('r-1', { name: 'Ronda Norte v2', description: 'x' }, options(db));
      const where = db.calls.routeFindOne[0];
      assert.strictEqual(where.id, 'r-1');
      assert.strictEqual(where.tenantId, TENANT);
    });

    it('applies EVERY writable field of a full patch to the row', async () => {
      const db = buildDb({ routes: [seedRow()] });
      const data: any = fullPayload();
      delete data.points;
      data.name = 'Ronda Norte EDITADA';
      data.description = 'Nueva descripción';
      data.notifyBefore = '1h';
      data.days = ['sat', 'sun'];
      data.assignedGuard = 'user-g2';
      data.vehicleId = 'veh-2';
      data.syncHitsBetweenGuards = false;
      data.autoCheckInByGeofence = false;

      await RouteRepository.update('r-1', data, options(db));

      const row = db.routeRows[0];
      assert.strictEqual(row._updates.length, 1);
      assert.strictEqual(row.name, 'Ronda Norte EDITADA');
      assert.strictEqual(row.description, 'Nueva descripción');
      assert.strictEqual(row.continuous, false);
      assert.strictEqual(row.windowStart, data.windowStart);
      assert.strictEqual(row.windowEnd, data.windowEnd);
      assert.deepStrictEqual(row.days, ['sat', 'sun']);
      assert.strictEqual(row.assignedGuard, 'user-g2');
      assert.strictEqual(row.vehicleId, 'veh-2');
      assert.strictEqual(row.syncHitsBetweenGuards, false, 'explicit false must persist');
      assert.strictEqual(row.forceVehicleRouteOrder, true);
      assert.strictEqual(row.notifyBefore, '1h');
      assert.strictEqual(row.autoCheckInByGeofence, false, 'explicit false must persist');
      assert.strictEqual(row.forceCheckInBeforeStart, true);
      assert.strictEqual(row._updates[0].updatedById, USER_ID);
    });

    it('a PARTIAL patch must NOT wipe the window/guard/vehicle nor reset toggles', async () => {
      const db = buildDb({ routes: [seedRow()] });
      await RouteRepository.update('r-1', { name: 'Solo renombrada', description: 'Descripción original' }, options(db));
      const row = db.routeRows[0];
      assert.strictEqual(row.name, 'Solo renombrada');
      assert.ok(row.windowStart, 'windowStart must survive a partial update');
      assert.ok(row.windowEnd, 'windowEnd must survive a partial update');
      assert.strictEqual(row.assignedGuard, 'user-g1', 'assignedGuard must survive');
      assert.strictEqual(row.vehicleId, 'veh-1', 'vehicleId must survive');
      assert.strictEqual(row.syncHitsBetweenGuards, true, 'absent toggle must not reset to false');
      assert.strictEqual(row.autoCheckInByGeofence, true, 'absent toggle must not reset to false');
      assert.strictEqual(row.notifyBefore, '30m');
      assert.deepStrictEqual(row.days, ['mon']);
    });

    // FIXED: description is now presence-guarded in RouteRepository.update like
    // every other field — a partial patch that omits it leaves it untouched.
    it('a PARTIAL patch must NOT wipe the stored description', async () => {
      const db = buildDb({ routes: [seedRow()] });
      await RouteRepository.update('r-1', { name: 'Solo renombrada' }, options(db));
      const row = db.routeRows[0];
      assert.strictEqual(
        row.description,
        'Descripción original',
        'description wiped by a partial update',
      );
    });

    it('replaces the points atomically: destroys the old set and bulk-inserts the new one', async () => {
      const db = buildDb({ routes: [seedRow()] });
      const data: any = {
        name: 'Ronda Norte',
        description: 'Descripción original',
        points: [
          { siteId: 'site-9', order: 1, duration: 5, scheduledHits: 3, address: 'Nueva parada', lat: -0.2, lng: -78.5 },
        ],
      };
      await RouteRepository.update('r-1', data, options(db));

      assert.strictEqual(db.calls.pointDestroy.length, 1);
      assert.strictEqual(db.calls.pointDestroy[0].routeId, 'r-1');
      assert.strictEqual(db.calls.pointBulkCreate.length, 1);
      const [np] = db.calls.pointBulkCreate[0];
      assert.strictEqual(np.siteId, 'site-9');
      assert.strictEqual(np.duration, 5);
      assert.strictEqual(np.scheduledHits, 3);
      assert.strictEqual(np.address, 'Nueva parada');
    });

    // FIXED: the destroy + bulkCreate point replacement in update() now carries
    // `siteType`/`tasks` like create does, so route edits keep them.
    it('update() keeps the per-stop siteType/tasks when replacing points', async () => {
      const db = buildDb({ routes: [seedRow()] });
      await RouteRepository.update(
        'r-1',
        {
          name: 'Ronda Norte',
          description: 'Descripción original',
          points: [{ siteId: 'site-9', order: 1, siteType: 'businessInfo', tasks: [{ id: 't9', label: 'Foto del acceso' }] }],
        },
        options(db),
      );
      const [np] = db.calls.pointBulkCreate[0];
      assert.strictEqual(np.siteType, 'businessInfo', 'siteType silently dropped on point re-create');
      assert.deepStrictEqual(np.tasks, [{ id: 't9', label: 'Foto del acceso' }], 'tasks silently dropped on point re-create');
    });

    it('404s (does not silently no-op) when the id belongs to ANOTHER tenant', async () => {
      const db = buildDb({ routes: [seedRow({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => RouteRepository.update('r-1', { name: 'x', description: 'y' }, options(db)),
        Error404,
      );
      assert.strictEqual(db.routeRows[0]._updates.length, 0, 'foreign row must not be touched');
    });

    it('does NOT swallow a db failure on update (error propagates)', async () => {
      const db = buildDb({ routes: [seedRow()] });
      db.routeRows[0].update = async () => {
        throw new Error('Lock wait timeout exceeded');
      };
      await assert.rejects(
        () => RouteRepository.update('r-1', { name: 'x', description: 'y' }, options(db)),
        /Lock wait timeout/,
      );
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row', async () => {
      const db = buildDb({ routes: [{ id: 'r-1', tenantId: TENANT, name: 'R' }] });
      await RouteRepository.destroy('r-1', options(db));
      assert.strictEqual(db.routeRows[0]._destroyed, true);
    });

    it('404s for a row of another tenant instead of deleting it', async () => {
      const db = buildDb({ routes: [{ id: 'r-1', tenantId: OTHER_TENANT, name: 'R' }] });
      await assert.rejects(() => RouteRepository.destroy('r-1', options(db)), Error404);
      assert.strictEqual(db.routeRows[0]._destroyed, false);
    });
  });
});

// ═════════════════════════ routeRun (daily completion) ═══════════════════════

function makeRes() {
  const r: any = {
    statusCode: null as number | null,
    body: undefined as any,
    status(c: number) { r.statusCode = c; return r; },
    send(p?: any) { if (r.statusCode == null) r.statusCode = 200; r.body = p; return r; },
    json(p?: any) { if (r.statusCode == null) r.statusCode = 200; r.body = p; return r; },
    sendStatus(c: number) { r.statusCode = c; return r; },
    header() { return r; },
  };
  return r;
}

function captureRoutes() {
  const handlers: Record<string, any> = {};
  const app = {
    get: (p: string, h: any) => { handlers[`GET ${p}`] = h; },
    post: (p: string, h: any) => { handlers[`POST ${p}`] = h; },
    delete: (p: string, h: any) => { handlers[`DELETE ${p}`] = h; },
  };
  (routeRunRoutes as any)(app);
  return handlers;
}

function makeReq(db: any, extra: any = {}) {
  return {
    database: db,
    currentTenant: { id: TENANT },
    currentUser: ADMIN_USER,
    language: 'en',
    params: {},
    query: {},
    body: {},
    ...extra,
  };
}

describe('crud-g05 · routeRun handlers (POST /route/:routeId/run)', () => {
  const handlers = captureRoutes();
  const postRun = handlers['POST /tenant/:tenantId/route/:routeId/run'];

  it('creates the run with every field (status/note/date/completedBy/tenant/route)', async () => {
    const db = buildDb();
    const req = makeReq(db, {
      params: { routeId: 'r-77' },
      body: { data: { date: '2026-07-14', status: 'skipped', note: 'Vía cerrada por derrumbe' } },
    });
    const res = makeRes();
    await postRun(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.calls.runCreate.length, 1, 'exactly one INSERT');
    const p = db.calls.runCreate[0];
    assert.strictEqual(p.status, 'skipped');
    assert.strictEqual(p.note, 'Vía cerrada por derrumbe');
    assert.strictEqual(p.date, '2026-07-14');
    assert.strictEqual(p.routeId, 'r-77');
    assert.strictEqual(p.tenantId, TENANT);
    assert.strictEqual(p.completedById, USER_ID);
    assert.strictEqual(p.completedByName, 'Admin Uno');
    assert.ok(p.completedAt instanceof Date);
  });

  it('defaults status=completed and date=today when omitted', async () => {
    const db = buildDb();
    const req = makeReq(db, { params: { routeId: 'r-77' }, body: { data: {} } });
    const res = makeRes();
    await postRun(req, res);
    const p = db.calls.runCreate[0];
    assert.strictEqual(p.status, 'completed');
    assert.strictEqual(p.date, new Date().toISOString().slice(0, 10));
    assert.strictEqual(p.note, null);
  });

  it('UPSERTS: a second mark for the same route+day updates the existing row instead of duplicating', async () => {
    const db = buildDb({
      routeRuns: [{ id: 'run-1', tenantId: TENANT, routeId: 'r-77', date: '2026-07-14', status: 'completed', note: null }],
    });
    const req = makeReq(db, {
      params: { routeId: 'r-77' },
      body: { data: { date: '2026-07-14', status: 'skipped', note: 'corregido' } },
    });
    const res = makeRes();
    await postRun(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.calls.runCreate.length, 0, 'must not create a duplicate row');
    const row = db.runRows[0];
    assert.strictEqual(row._updates.length, 1);
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.note, 'corregido');
    assert.strictEqual(row.completedById, USER_ID);
  });

  it('a db failure is NOT swallowed into a 200 (responds with the error status)', async () => {
    const db = buildDb();
    db.routeRun.findOne = async () => {
      throw new Error('ER_LOCK_DEADLOCK');
    };
    const req = makeReq(db, { params: { routeId: 'r-77' }, body: { data: {} } });
    const res = makeRes();
    await postRun(req, res);
    assert.notStrictEqual(res.statusCode, 200, 'db failure must not produce a success response');
    assert.strictEqual(res.statusCode, 500);
  });

  it('DELETE undo removes the run for the given day', async () => {
    const db = buildDb({
      routeRuns: [{ id: 'run-1', tenantId: TENANT, routeId: 'r-77', date: '2026-07-14', status: 'completed' }],
    });
    const del = handlers['DELETE /tenant/:tenantId/route/:routeId/run'];
    const req = makeReq(db, { params: { routeId: 'r-77' }, query: { date: '2026-07-14' } });
    const res = makeRes();
    await del(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.runRows[0]._destroyed, true);
  });
});
