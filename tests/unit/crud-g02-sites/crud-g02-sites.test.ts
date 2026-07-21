/**
 * Unit tests — CRUD persistence fidelity for module group g02-sites:
 *   businessInfo (post sites), station, stationOrder (consignas), category,
 *   postSite (notes wiring; its core CRUD IS businessInfo).
 *
 * Context: tenants report "things are not being saved". These tests call the
 * REAL repository/service/handler write paths against a tiny in-memory fake db
 * (Sequelize-shaped rows with get/update/destroy; models that RECORD their
 * calls) and assert:
 *   - create() receives EVERY writable field the frontend can send,
 *   - update() targets the right row (id + tenantId in the where) and applies
 *     the whole patch,
 *   - db failures are propagated (rolled back + rethrown), never swallowed
 *     into a success response.
 *
 * Tests marked it.skip document REAL bugs found in src/ (field dropped /
 * change silently ignored) — see the `// BUG:` comment above each.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g02-sites/**' + '/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import BusinessInfoRepository from '../../../src/database/repositories/businessInfoRepository';
import BusinessInfoService from '../../../src/services/businessInfoService';
import businessInfoCreateHandler from '../../../src/api/businessInfo/businessInfoCreate';
import businessInfoUpdateHandler from '../../../src/api/businessInfo/businessInfoUpdate';

import StationRepository from '../../../src/database/repositories/stationRepository';
import StationService from '../../../src/services/stationService';

import CategoryRepository from '../../../src/database/repositories/categoryRepository';
import CategoryService from '../../../src/services/categoryService';
import categoryCreateHandler from '../../../src/api/category/categoryCreate';

import stationOrderRoutes from '../../../src/api/stationOrder';

import NoteService from '../../../src/services/noteService';
import postSiteNoteCreateHandler from '../../../src/api/postSite/postSiteNoteCreate';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// Superadmin + tenant-admin user: passes PermissionChecker and the repos'
// role-based ACL branches, so tests exercise the WRITE logic, not the ACL.
const USER = {
  id: 'user-1',
  email: 'ops@example.com',
  emailVerified: true,
  isSuperadmin: true,
  tenants: [
    { tenant: { id: TENANT_A }, status: 'active', roles: ['admin'] },
  ],
};

// ─────────────────────── fake rows / models (Sequelize-shaped) ───────────────

/** A Sequelize-instance-shaped row. Records update()/destroy() calls. */
function makeRow(data: any, extras: any = {}) {
  const row: any = {
    ...data,
    _updates: [] as any[],
    _destroyed: false,
    get(opts?: any) {
      void opts;
      const plain: any = {};
      for (const k of Object.keys(data)) plain[k] = data[k];
      return plain;
    },
    async update(patch: any) {
      row._updates.push(patch);
      Object.assign(data, patch);
      Object.assign(row, patch);
      return row;
    },
    async destroy() {
      row._destroyed = true;
    },
    ...extras,
  };
  return row;
}

/** Where matcher: plain equality + Op.in / Op.notIn / Op.and; undefined==null. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const v = (where as any)[key];
    if (typeof key === 'symbol') {
      const name = key.toString();
      if (name === 'Symbol(and)') {
        if (!(v as any[]).every((c) => matchWhere(row, c))) return false;
      }
      continue; // other top-level ops: not needed here
    }
    if (v === null) {
      if (row[key] !== null && row[key] !== undefined) return false;
      continue;
    }
    if (Array.isArray(v)) {
      if (!v.includes(row[key])) return false;
      continue;
    }
    if (typeof v === 'object') {
      const syms = Object.getOwnPropertySymbols(v);
      if (syms.length) {
        for (const s of syms) {
          const sv = (v as any)[s];
          const n = s.toString();
          if (n === 'Symbol(notIn)' && sv.includes(row[key])) return false;
          if (n === 'Symbol(in)' && !sv.includes(row[key])) return false;
        }
      } else if (JSON.stringify(row[key]) !== JSON.stringify(v)) {
        return false;
      }
      continue;
    }
    if (row[key] !== v) return false;
  }
  return true;
}

/** A model whose create/findOne/findAll/count record every call. */
function makeModel(name: string, opts: { rows?: any[]; tableName?: string; rowExtras?: () => any } = {}) {
  let seq = 0;
  const model: any = {
    name,
    rows: opts.rows || [],
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[], count: [] as any[] },
    getTableName: () => opts.tableName || `${name}s`,
    async create(data: any, o?: any) {
      model.calls.create.push({ data, options: o });
      const row = makeRow(
        { id: data.id || `${name}-${++seq}`, ...data },
        opts.rowExtras ? opts.rowExtras() : {},
      );
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => matchWhere(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => matchWhere(r, q.where));
    },
    async count(q: any = {}) {
      model.calls.count.push(q);
      return model.rows.filter((r: any) => matchWhere(r, q.where)).length;
    },
    async destroy(q: any = {}) {
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      victims.forEach((r: any) => (r._destroyed = true));
      return victims.length;
    },
  };
  return model;
}

function makeTxn() {
  const txn = {
    committed: false,
    rolledBack: false,
    async commit() { txn.committed = true; },
    async rollback() { txn.rolledBack = true; },
  };
  return txn;
}

const bizRowExtras = () => ({
  getLogo: async () => [],
  getClientAccount: async () => null,
});

const stationRowExtras = () => {
  const sets: any = {};
  return {
    _sets: sets,
    getAssignedGuards: async () => [],
    getTasks: async () => [],
    getReports: async () => [],
    getIncidents: async () => [],
    getCheckpoints: async () => [],
    getPatrol: async () => [],
    setAssignedGuards: async (v: any) => { sets.assignedGuards = v; },
    setTasks: async (v: any) => { sets.tasks = v; },
    setReports: async (v: any) => { sets.reports = v; },
    setIncidents: async (v: any) => { sets.incidents = v; },
    setCheckpoints: async (v: any) => { sets.checkpoints = v; },
    setPatrol: async (v: any) => { sets.patrol = v; },
  };
};

function buildDb() {
  const db: any = {
    Sequelize: require('sequelize'),
    businessInfo: makeModel('businessInfo', { rowExtras: bizRowExtras }),
    station: makeModel('station', { rowExtras: stationRowExtras }),
    category: makeModel('category'),
    stationOrder: makeModel('stationOrder'),
    file: makeModel('file'),
    auditLog: makeModel('auditLog'),
    clientAccount: makeModel('clientAccount'),
    tenantUser: makeModel('tenantUser'),
    tenant_user_post_sites: makeModel('tenant_user_post_sites'),
  };
  const txn = makeTxn();
  db._txn = txn;
  db.sequelize = { transaction: async () => txn };
  return db;
}

function options(db: any, tenantId = TENANT_A) {
  return {
    database: db,
    currentUser: USER,
    currentTenant: { id: tenantId },
    language: 'en',
  } as any;
}

function makeRes() {
  const r: any = {
    statusCode: null as number | null,
    body: undefined as any,
    status(c: number) { r.statusCode = c; return r; },
    send(p?: any) { if (r.statusCode == null) r.statusCode = 200; r.body = p; return r; },
    json(p?: any) { r.body = p; return r; },
    sendStatus(c: number) { r.statusCode = c; return r; },
    header() { return r; },
  };
  return r;
}

// ═════════════════════════ businessInfo (post sites) ═════════════════════════

describe('crud-g02 · businessInfo repository', () => {
  afterEach(() => sinon.restore());

  // Every writable field the frontend can send that the repo whitelists.
  const FULL_CREATE = {
    companyName: 'Sitio Centro Histórico',
    description: 'Puesto 24h con dos vigilantes',
    contactPhone: '+593999000111',
    contactEmail: 'sitio@cliente.com',
    address: 'Av. 10 de Agosto N20-30',
    latitud: -0.180653,
    longitud: -78.467838,
    categoryIds: ['cat-1', 'cat-2'],
    clientAccountId: 'client-1',
    secondAddress: 'Edificio B, piso 2',
    country: 'Ecuador',
    city: 'Quito',
    postalCode: '170401',
    active: true,
    importHash: 'hash-123',
    serviceType: 'manned',
    serviceConfig: { guardsPerShift: 2, armed: false },
  };

  it('create() persists EVERY whitelisted field with the exact values + tenant/user stamps', async () => {
    const db = buildDb();
    await BusinessInfoRepository.create({ ...FULL_CREATE }, options(db));

    assert.strictEqual(db.businessInfo.calls.create.length, 1, 'exactly one INSERT');
    const written = db.businessInfo.calls.create[0].data;
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" must reach the INSERT unchanged`);
    }
    assert.strictEqual(written.tenantId, TENANT_A);
    assert.strictEqual(written.createdById, USER.id);
    assert.strictEqual(written.updatedById, USER.id);
    // audit trail written
    assert.strictEqual(db.auditLog.calls.create.length, 1);
    assert.strictEqual(db.auditLog.calls.create[0].data.action, 'create');
  });

  // FIXED: BusinessInfoRepository.create's pick whitelist now includes
  // 'chargeRate'/'payRate' (matching the update whitelist), so rates set while
  // creating a post site persist on the first save.
  it('create() persists chargeRate/payRate (tarifas) like update() does', async () => {
    const db = buildDb();
    await BusinessInfoRepository.create(
      { ...FULL_CREATE, chargeRate: 12.5, payRate: 8.75 },
      options(db),
    );
    const written = db.businessInfo.calls.create[0].data;
    assert.strictEqual(written.chargeRate, 12.5, 'chargeRate must reach the INSERT');
    assert.strictEqual(written.payRate, 8.75, 'payRate must reach the INSERT');
  });

  it('update() targets {id, tenantId} and applies the FULL patch (incl. rates + false booleans)', async () => {
    const db = buildDb();
    const row = makeRow(
      { id: 'bi-1', tenantId: TENANT_A, ...FULL_CREATE },
      bizRowExtras(),
    );
    db.businessInfo.rows.push(row);

    const patch = {
      companyName: 'Sitio Centro RENOMBRADO',
      description: 'Nueva descripción',
      contactPhone: '+593888777666',
      contactEmail: 'nuevo@cliente.com',
      address: 'Calle Nueva 123',
      latitud: -0.2, // coords provided → repo must NOT geocode
      longitud: -78.5,
      categoryIds: ['cat-9'],
      clientAccountId: 'client-2',
      secondAddress: 'Torre A',
      country: 'Ecuador',
      city: 'Guayaquil',
      postalCode: '090101',
      active: false,
      serviceType: 'patrol',
      serviceConfig: { vehicles: 1 },
      chargeRate: 15.25,
      payRate: 9.1,
    };

    await BusinessInfoRepository.update('bi-1', patch, options(db));

    // where-clause targeted the right row in the right tenant
    const firstFind = db.businessInfo.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'bi-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT_A);

    assert.strictEqual(row._updates.length, 1, 'exactly one UPDATE on the row');
    const applied = row._updates[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `patch field "${k}" must be applied`);
    }
    assert.strictEqual(applied.updatedById, USER.id);
  });

  it('update() from ANOTHER tenant → 404, row untouched (no silent cross-tenant write)', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'bi-1', tenantId: TENANT_A, ...FULL_CREATE }, bizRowExtras());
    db.businessInfo.rows.push(row);

    await assert.rejects(
      BusinessInfoRepository.update('bi-1', { companyName: 'hijacked' }, options(db, TENANT_B)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(row._updates.length, 0, 'the row must not be written');
  });

  // FIXED: BusinessInfoRepository.update now only calls
  // FileRepository.replaceRelationFiles when data.logo !== undefined, so a
  // partial update (e.g. the archive toggle sending only {active}) no longer
  // destroys the stored logo file rows.
  it('a partial update that does not resend the logo must NOT delete the stored logo', async () => {
    const db = buildDb();
    db.businessInfo.rows.push(
      makeRow({ id: 'bi-1', tenantId: TENANT_A, ...FULL_CREATE }, bizRowExtras()),
    );
    const logoFile = makeRow({
      id: 'file-1',
      belongsTo: 'businessInfos',
      belongsToId: 'bi-1',
      belongsToColumn: 'logo',
      privateUrl: null,
      publicUrl: 'https://cdn/logo.png',
    });
    db.file.rows.push(logoFile);

    await BusinessInfoRepository.update(
      'bi-1',
      { active: true, latitud: -0.2, longitud: -78.5 },
      options(db),
    );

    assert.strictEqual(logoFile._destroyed, false, 'existing logo file must survive a partial update');
  });
});

describe('crud-g02 · businessInfo service (errors are NOT swallowed)', () => {
  afterEach(() => sinon.restore());

  it('update() propagates a db failure and rolls back (no fake success)', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'bi-1', tenantId: TENANT_A, companyName: 'X' }, bizRowExtras());
    row.update = async () => { throw new Error('DB write failed'); };
    db.businessInfo.rows.push(row);

    const svc = new BusinessInfoService(options(db));
    await assert.rejects(
      svc.update('bi-1', { companyName: 'Y', latitud: 1, longitud: 1, active: true }),
      /DB write failed/,
    );
    assert.strictEqual(db._txn.rolledBack, true, 'transaction must be rolled back');
    assert.strictEqual(db._txn.committed, false);
  });

  it('archiving (active=false) with assigned guards → Error400, nothing written', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'bi-1', tenantId: TENANT_A, companyName: 'X' }, bizRowExtras());
    db.businessInfo.rows.push(row);
    // two guards assigned via the pivot
    db.tenant_user_post_sites.rows.push(
      makeRow({ id: 'p1', businessInfoId: 'bi-1' }),
      makeRow({ id: 'p2', businessInfoId: 'bi-1' }),
    );

    const svc = new BusinessInfoService(options(db));
    await assert.rejects(svc.update('bi-1', { active: false }), (e: any) => e.code === 400);
    assert.strictEqual(row._updates.length, 0, 'row must not be updated');
    assert.strictEqual(db._txn.rolledBack, true);
  });
});

describe('crud-g02 · businessInfo API handlers (payload → service mapping)', () => {
  afterEach(() => sinon.restore());

  function reqFor(body: any, params: any = {}) {
    return {
      currentUser: USER,
      currentTenant: { id: TENANT_A, plan: 'enterprise' },
      language: 'en',
      params,
      body,
    } as any;
  }

  it('create handler forwards every canonical field to the service', async () => {
    let captured: any = null;
    if ((BusinessInfoService.prototype as any).create?.restore) (BusinessInfoService.prototype as any).create.restore();
    sinon.stub(BusinessInfoService.prototype, 'create').callsFake(async (data: any) => {
      captured = data;
      return { id: 'bi-1' };
    });

    const body = {
      data: {
        companyName: 'Sitio Norte',
        description: 'desc',
        contactPhone: '+59311111',
        contactEmail: 'a@b.c',
        address: 'Calle 1',
        latitud: -0.1,
        longitud: -78.4,
        categoryIds: ['c1'],
        active: true,
        clientAccountId: 'client-1',
        secondAddress: 'dpto 2',
        country: 'Ecuador',
        city: 'Quito',
        postalCode: '1704',
        serviceType: 'cctv',
        serviceConfig: { cameras: 4 },
        importHash: 'h1',
        logo: [{ id: 'f1' }],
      },
    };
    const res = makeRes();
    await businessInfoCreateHandler(reqFor(body), res, () => undefined);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(captured, 'service.create must be called');
    for (const [k, v] of Object.entries(body.data)) {
      assert.deepStrictEqual(captured[k], v, `handler must forward "${k}"`);
    }
  });

  it('create handler maps frontend ALIASES (name/phone/email/location) onto canonical fields', async () => {
    let captured: any = null;
    if ((BusinessInfoService.prototype as any).create?.restore) (BusinessInfoService.prototype as any).create.restore();
    sinon.stub(BusinessInfoService.prototype, 'create').callsFake(async (data: any) => {
      captured = data;
      return { id: 'bi-1' };
    });

    const res = makeRes();
    await businessInfoCreateHandler(
      reqFor({ data: { name: 'Sitio Alias', phone: '099', email: 'x@y.z', location: 'Av. Sur', latitude: 1.5, longitude: -2.5 } }),
      res,
      () => undefined,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(captured.companyName, 'Sitio Alias');
    assert.strictEqual(captured.contactPhone, '099');
    assert.strictEqual(captured.contactEmail, 'x@y.z');
    assert.strictEqual(captured.address, 'Av. Sur');
    assert.strictEqual(captured.latitud, 1.5);
    assert.strictEqual(captured.longitud, -2.5);
  });

  it('create handler returns 400 (NOT a placeholder save) when companyName is missing', async () => {
    if ((BusinessInfoService.prototype as any).create?.restore) (BusinessInfoService.prototype as any).create.restore();
    const createStub = sinon.stub(BusinessInfoService.prototype, 'create').resolves({ id: 'nope' } as any);
    const res = makeRes();
    await businessInfoCreateHandler(reqFor({ data: { description: 'sin nombre' } }), res, () => undefined);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(createStub.called, false, 'service must NOT be called');
  });

  it('create handler surfaces a service failure as an error response (no success)', async () => {
    const err: any = new Error('validation exploded');
    err.code = 400;
    if ((BusinessInfoService.prototype as any).create?.restore) (BusinessInfoService.prototype as any).create.restore();
    sinon.stub(BusinessInfoService.prototype, 'create').rejects(err);
    const res = makeRes();
    await businessInfoCreateHandler(reqFor({ data: { companyName: 'Sitio' } }), res, () => undefined);

    assert.strictEqual(res.statusCode, 400, 'must respond with the error, not 200');
  });

  // FIXED: the create handler's `mapped` object now forwards
  // chargeRate/payRate with the same coercion the update handler applies
  // ('' → null, else Number), so rates entered on the creation form reach the
  // service.
  it('create handler forwards chargeRate/payRate like the update handler does', async () => {
    let captured: any = null;
    if ((BusinessInfoService.prototype as any).create?.restore) (BusinessInfoService.prototype as any).create.restore();
    sinon.stub(BusinessInfoService.prototype, 'create').callsFake(async (data: any) => {
      captured = data;
      return { id: 'bi-1' };
    });
    const res = makeRes();
    await businessInfoCreateHandler(
      reqFor({ data: { companyName: 'Sitio', chargeRate: 12.5, payRate: 8.75 } }),
      res,
      () => undefined,
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(captured.chargeRate, 12.5);
    assert.strictEqual(captured.payRate, 8.75);
  });

  it('update handler forwards the full patch (incl. numeric coercion of rates) to the service', async () => {
    let capturedId: any = null;
    let captured: any = null;
    if ((BusinessInfoService.prototype as any).update?.restore) (BusinessInfoService.prototype as any).update.restore();
    sinon.stub(BusinessInfoService.prototype, 'update').callsFake(async (id: any, data: any) => {
      capturedId = id;
      captured = data;
      return { id };
    });

    const res = makeRes();
    await businessInfoUpdateHandler(
      reqFor(
        {
          data: {
            companyName: 'Sitio Editado',
            description: 'd2',
            contactPhone: '098',
            contactEmail: 'e@f.g',
            address: 'Calle 2',
            secondAddress: 'p3',
            city: 'Cuenca',
            country: 'Ecuador',
            postalCode: '0101',
            latitud: -2.9,
            longitud: -79.0,
            categoryIds: ['c2'],
            clientAccountId: 'client-3',
            serviceType: 'alarm',
            serviceConfig: { zones: 8 },
            chargeRate: '15.5', // string from the form → must become 15.5
            payRate: '9.25',
            active: 'active', // status-string form → boolean
          },
        },
        { id: 'bi-77' },
      ),
      res,
      () => undefined,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedId, 'bi-77');
    assert.strictEqual(captured.companyName, 'Sitio Editado');
    assert.strictEqual(captured.chargeRate, 15.5);
    assert.strictEqual(captured.payRate, 9.25);
    assert.strictEqual(captured.active, true);
    assert.strictEqual(captured.clientAccountId, 'client-3');
    assert.deepStrictEqual(captured.serviceConfig, { zones: 8 });
  });

  // FIXED: businessInfoUpdate.ts's alias resolver now returns an explicit
  // null (second pass, after non-null aliases) so clear operations like
  // { clientAccountId: null } reach the service and the FK is actually
  // cleared instead of being silently dropped.
  it('update handler forwards an explicit null (clearing clientAccountId) to the service', async () => {
    let captured: any = null;
    if ((BusinessInfoService.prototype as any).update?.restore) (BusinessInfoService.prototype as any).update.restore();
    sinon.stub(BusinessInfoService.prototype, 'update').callsFake(async (_id: any, data: any) => {
      captured = data;
      return { id: _id };
    });
    const res = makeRes();
    await businessInfoUpdateHandler(
      reqFor({ data: { clientAccountId: null } }, { id: 'bi-1' }),
      res,
      () => undefined,
    );
    assert.strictEqual(res.statusCode, 200);
    assert.ok(
      Object.prototype.hasOwnProperty.call(captured, 'clientAccountId'),
      'an explicit null must reach the service so the FK can be cleared',
    );
    assert.strictEqual(captured.clientAccountId, null);
  });
});

// ═══════════════════════════════ station ════════════════════════════════════

describe('crud-g02 · station repository', () => {
  afterEach(() => sinon.restore());

  const FULL_STATION = {
    stationName: 'Garita Principal',
    nickname: 'Alfa-1',
    latitud: -0.18,
    longitud: -78.46,
    numberOfGuardsInStation: '2',
    stationSchedule: '24h',
    startingTimeInDay: '08:00',
    finishTimeInDay: '20:00',
    geofenceRadius: 150,
    geofencePolygon: [
      { lat: -0.181, lng: -78.469 },
      { lat: -0.181, lng: -78.466 },
      { lat: -0.179, lng: -78.466 },
    ],
    importHash: 'st-hash',
  };

  it('create() persists every whitelisted field + FK columns + stamps, and sets associations', async () => {
    const db = buildDb();
    await StationRepository.create(
      {
        ...FULL_STATION,
        clockInEarlyBufferMin: 10,
        clockInLateGraceMin: 20,
        postSite: 'ps-1',
        stationOrigin: 'client-1',
        assignedGuards: ['g-1', 'g-2'],
        checkpoints: ['cp-1'],
        tasks: [],
        reports: [],
        incidents: [],
        patrol: [],
      },
      options(db),
    );

    assert.strictEqual(db.station.calls.create.length, 1);
    const written = db.station.calls.create[0].data;
    for (const [k, v] of Object.entries(FULL_STATION)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" must reach the INSERT`);
    }
    assert.strictEqual(written.clockInEarlyBufferMin, 10);
    assert.strictEqual(written.clockInLateGraceMin, 20);
    assert.strictEqual(written.postSiteId, 'ps-1', 'postSite alias must land on postSiteId');
    assert.strictEqual(written.stationOriginId, 'client-1');
    assert.strictEqual(written.tenantId, TENANT_A);
    assert.strictEqual(written.createdById, USER.id);

    const row = db.station.rows[0];
    // The stationAssignedGuardsUser pivot is DEAD — guard↔station lives only in
    // guardAssignment. create() must NOT set assignedGuards (would resurrect it).
    assert.strictEqual(row._sets.assignedGuards, undefined, 'dead pivot: assignedGuards is never set');
    assert.deepStrictEqual(row._sets.checkpoints, ['cp-1']);
  });

  // FIXED: StationRepository.create's pick list now includes 'isMobile'
  // (matching the update pick list), so a station created as mobile (unidad
  // móvil / patrulla) persists the flag on the first save.
  // ('scheduleType'/'rotationStyleId' stay excluded deliberately — the
  // scheduling module writes them directly.)
  it('create() persists isMobile like update() does', async () => {
    const db = buildDb();
    await StationRepository.create(
      { ...FULL_STATION, isMobile: true },
      options(db),
    );
    const written = db.station.calls.create[0].data;
    assert.strictEqual(written.isMobile, true, 'isMobile must reach the INSERT');
  });

  it('update() targets {id, tenantId} and applies the full patch incl. isMobile + updatedById', async () => {
    const db = buildDb();
    const row = makeRow(
      { id: 'st-1', tenantId: TENANT_A, postSiteId: 'ps-1', ...FULL_STATION },
      stationRowExtras(),
    );
    db.station.rows.push(row);

    const patch = {
      stationName: 'Garita Renombrada',
      nickname: 'Bravo-2',
      latitud: -0.2,
      longitud: -78.5,
      numberOfGuardsInStation: '3',
      stationSchedule: '12h',
      startingTimeInDay: '07:00',
      finishTimeInDay: '19:00',
      geofenceRadius: 200,
      geofencePolygon: null,
      clockInEarlyBufferMin: 5,
      clockInLateGraceMin: 25,
      isMobile: true,
    };

    await StationRepository.update('st-1', patch, options(db));

    const firstFind = db.station.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'st-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT_A);

    const applied = row._updates[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `patch field "${k}" must be applied`);
    }
    assert.strictEqual(applied.updatedById, USER.id);
  });

  it('a PARTIAL update must not touch postSiteId, stationOriginId or any association', async () => {
    const db = buildDb();
    const row = makeRow(
      { id: 'st-1', tenantId: TENANT_A, postSiteId: 'ps-1', stationOriginId: 'client-1', ...FULL_STATION },
      stationRowExtras(),
    );
    db.station.rows.push(row);

    await StationRepository.update('st-1', { geofenceRadius: 300 }, options(db));

    const applied = row._updates[0];
    assert.strictEqual(applied.geofenceRadius, 300);
    assert.ok(!('postSiteId' in applied), 'postSiteId must not be in the patch');
    assert.ok(!('stationOriginId' in applied), 'stationOriginId must not be in the patch');
    assert.deepStrictEqual(row._sets, {}, 'no association may be re-set on a partial update');
    assert.strictEqual(row.postSiteId, 'ps-1', 'sitio link must survive');
  });

  it('update() applies FK + associations when the caller DID send them', async () => {
    const db = buildDb();
    const row = makeRow(
      { id: 'st-1', tenantId: TENANT_A, postSiteId: 'ps-1', ...FULL_STATION },
      stationRowExtras(),
    );
    db.station.rows.push(row);

    await StationRepository.update(
      'st-1',
      { postSiteId: 'ps-2', stationOrigin: 'client-9', assignedGuards: ['g-7'] },
      options(db),
    );

    const applied = row._updates[0];
    assert.strictEqual(applied.postSiteId, 'ps-2');
    assert.strictEqual(applied.stationOriginId, 'client-9');
    // Dead pivot: update() ignores assignedGuards (guard↔station = guardAssignment).
    assert.strictEqual(row._sets.assignedGuards, undefined, 'dead pivot: assignedGuards is never set on update');
  });

  it('update() from another tenant → 404, row untouched', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'st-1', tenantId: TENANT_A, ...FULL_STATION }, stationRowExtras());
    db.station.rows.push(row);

    await assert.rejects(
      StationRepository.update('st-1', { stationName: 'hijacked' }, options(db, TENANT_B)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(row._updates.length, 0);
  });
});

describe('crud-g02 · station service (errors are NOT swallowed)', () => {
  afterEach(() => sinon.restore());

  it('create() propagates a db INSERT failure and rolls back', async () => {
    const db = buildDb();
    db.station.create = async () => { throw new Error('INSERT blew up'); };

    const svc = new StationService(options(db));
    await assert.rejects(svc.create({ stationName: 'X' }), /INSERT blew up/);
    assert.strictEqual(db._txn.rolledBack, true);
    assert.strictEqual(db._txn.committed, false);
  });
});

// ═══════════════════════════════ category ═══════════════════════════════════

describe('crud-g02 · category repository/service', () => {
  afterEach(() => sinon.restore());

  const FULL_CATEGORY = {
    name: 'Residencial',
    description: 'Clientes residenciales',
    module: 'clientAccount',
    importHash: 'cat-hash',
  };

  it('create() persists every writable field + tenant/user stamps', async () => {
    const db = buildDb();
    await CategoryRepository.create({ ...FULL_CATEGORY }, options(db));

    assert.strictEqual(db.category.calls.create.length, 1);
    const written = db.category.calls.create[0].data;
    for (const [k, v] of Object.entries(FULL_CATEGORY)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" must reach the INSERT`);
    }
    assert.strictEqual(written.tenantId, TENANT_A);
    assert.strictEqual(written.createdById, USER.id);
    assert.strictEqual(written.updatedById, USER.id);
  });

  it('update() targets {id, tenantId} and applies the whole patch', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'cat-1', tenantId: TENANT_A, ...FULL_CATEGORY });
    db.category.rows.push(row);

    const patch = { name: 'Comercial', description: 'desc 2', module: 'products' };
    await CategoryRepository.update('cat-1', patch, options(db));

    const firstFind = db.category.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'cat-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT_A);

    const applied = row._updates[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `patch field "${k}" must be applied`);
    }
    assert.strictEqual(applied.updatedById, USER.id);
  });

  it('update() from another tenant → 404, row untouched', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'cat-1', tenantId: TENANT_A, ...FULL_CATEGORY });
    db.category.rows.push(row);

    await assert.rejects(
      CategoryRepository.update('cat-1', { name: 'hijacked' }, options(db, TENANT_B)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(row._updates.length, 0);
  });

  it('service.create() propagates a db failure and rolls back (not swallowed)', async () => {
    const db = buildDb();
    db.category.create = async () => { throw new Error('category INSERT failed'); };

    const svc = new CategoryService(options(db));
    await assert.rejects(svc.create({ ...FULL_CATEGORY }), /category INSERT failed/);
    assert.strictEqual(db._txn.rolledBack, true);
    assert.strictEqual(db._txn.committed, false);
  });

  it('create handler passes the request body straight to the service (unwrapped convention)', async () => {
    let captured: any = null;
    if ((CategoryService.prototype as any).create?.restore) (CategoryService.prototype as any).create.restore();
    sinon.stub(CategoryService.prototype, 'create').callsFake(async (data: any) => {
      captured = data;
      return { id: 'cat-1' };
    });
    const res = makeRes();
    await categoryCreateHandler(
      {
        currentUser: USER,
        currentTenant: { id: TENANT_A },
        language: 'en',
        params: {},
        body: { ...FULL_CATEGORY },
      } as any,
      res,
      () => undefined,
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(captured, FULL_CATEGORY);
  });
});

// ═════════════════════ stationOrder (consignas específicas) ══════════════════

describe('crud-g02 · stationOrder routes', () => {
  const routes: Record<string, any> = {};
  before(() => {
    const app: any = {
      get: (p: string, h: any) => (routes[`GET ${p}`] = h),
      post: (p: string, h: any) => (routes[`POST ${p}`] = h),
      put: (p: string, h: any) => (routes[`PUT ${p}`] = h),
      delete: (p: string, h: any) => (routes[`DELETE ${p}`] = h),
    };
    (stationOrderRoutes as any)(app);
  });
  afterEach(() => sinon.restore());

  const FULL_ORDER = {
    title: 'Abrir baños públicos',
    description: 'Todos los días al inicio del turno',
    time: '09:00',
    recurrence: 'weekly',
    days: [1, 3, 5],
    dayOfMonth: 15,
    date: '2026-07-20',
    priority: 'alta',
    active: true,
    notifyEnabled: true,
    notifyMinutesBefore: 10,
  };

  function orderReq(db: any, body: any, params: any = {}) {
    return {
      database: db,
      currentUser: USER,
      currentTenant: { id: TENANT_A },
      language: 'en',
      params: { tenantId: TENANT_A, stationId: 'st-1', ...params },
      body,
      query: {},
    } as any;
  }

  it('POST persists EVERY consigna field + stationId/postSiteId/tenant/user stamps', async () => {
    const db = buildDb();
    db.station.rows.push(makeRow({ id: 'st-1', tenantId: TENANT_A, postSiteId: 'ps-1' }, stationRowExtras()));

    const res = makeRes();
    await routes['POST /tenant/:tenantId/station/:stationId/orders'](
      orderReq(db, { data: { ...FULL_ORDER } }),
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.stationOrder.calls.create.length, 1);
    const written = db.stationOrder.calls.create[0].data;
    for (const [k, v] of Object.entries(FULL_ORDER)) {
      assert.deepStrictEqual(written[k], v, `consigna field "${k}" must reach the INSERT`);
    }
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.postSiteId, 'ps-1', 'postSiteId must be derived from the station');
    assert.strictEqual(written.tenantId, TENANT_A);
    assert.strictEqual(written.createdById, USER.id);
    assert.strictEqual(written.updatedById, USER.id);
  });

  it('PUT targets {id, tenantId, stationId} and applies the whole patch (incl. false/0 values)', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'so-1', tenantId: TENANT_A, stationId: 'st-1', ...FULL_ORDER });
    db.stationOrder.rows.push(row);

    const patch = {
      title: 'Cerrar baños públicos',
      description: 'nuevo detalle',
      time: '18:30',
      recurrence: 'daily',
      days: [],
      dayOfMonth: 1,
      date: '2026-08-01',
      priority: 'baja',
      active: false, // false must persist (not treated as "missing")
      notifyEnabled: false,
      notifyMinutesBefore: 0, // 0 must persist
    };

    const res = makeRes();
    await routes['PUT /tenant/:tenantId/station/:stationId/orders/:id'](
      orderReq(db, { data: patch }, { id: 'so-1' }),
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    const find = db.stationOrder.calls.findOne[0];
    assert.strictEqual(find.where.id, 'so-1');
    assert.strictEqual(find.where.tenantId, TENANT_A);
    assert.strictEqual(find.where.stationId, 'st-1');

    const applied = row._updates[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `patch field "${k}" must be applied`);
    }
    assert.strictEqual(applied.updatedById, USER.id);
  });

  it('PUT for a row of ANOTHER tenant/station writes nothing', async () => {
    const db = buildDb();
    const row = makeRow({ id: 'so-1', tenantId: TENANT_B, stationId: 'st-1', ...FULL_ORDER });
    db.stationOrder.rows.push(row);

    const res = makeRes();
    await routes['PUT /tenant/:tenantId/station/:stationId/orders/:id'](
      orderReq(db, { data: { title: 'hijacked' } }, { id: 'so-1' }),
      res,
    );

    assert.strictEqual(row._updates.length, 0, 'cross-tenant row must not be written');
    assert.strictEqual(res.body && res.body.success, false, 'response must signal the miss');
  });

  it('POST surfaces a db failure as an error response (not a fake 200 payload)', async () => {
    const db = buildDb();
    db.station.rows.push(makeRow({ id: 'st-1', tenantId: TENANT_A, postSiteId: null }, stationRowExtras()));
    db.stationOrder.create = async () => { throw new Error('consigna INSERT failed'); };

    const res = makeRes();
    await routes['POST /tenant/:tenantId/station/:stationId/orders'](
      orderReq(db, { data: { ...FULL_ORDER } }),
      res,
    );

    assert.strictEqual(res.statusCode, 500, 'db failure must produce an error status');
  });
});

// ═══════════════════ postSite notes (write wiring of the module) ═════════════

describe('crud-g02 · postSite note handlers', () => {
  afterEach(() => sinon.restore());

  it('note create forwards title/description/noteDate and pins notableType/notableId to the post site', async () => {
    let captured: any = null;
    if ((NoteService.prototype as any).create?.restore) (NoteService.prototype as any).create.restore();
    sinon.stub(NoteService.prototype, 'create').callsFake(async (data: any) => {
      captured = data;
      return { id: 'note-1' };
    });

    const res = makeRes();
    await postSiteNoteCreateHandler(
      {
        currentUser: USER,
        currentTenant: { id: TENANT_A },
        language: 'en',
        params: { tenantId: TENANT_A, id: 'ps-9' },
        body: { title: 'Novedad', description: 'Se cambió la cerradura', noteDate: '2026-07-13T10:00:00Z' },
      } as any,
      res,
      () => undefined,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(captured.title, 'Novedad');
    assert.strictEqual(captured.description, 'Se cambió la cerradura');
    assert.strictEqual(captured.noteDate, '2026-07-13T10:00:00Z');
    assert.strictEqual(captured.notableType, 'postSite');
    assert.strictEqual(captured.notableId, 'ps-9');
  });

  it('note create surfaces a service failure as an error response (not success)', async () => {
    const err: any = new Error('note failed');
    err.code = 400;
    if ((NoteService.prototype as any).create?.restore) (NoteService.prototype as any).create.restore();
    sinon.stub(NoteService.prototype, 'create').rejects(err);

    const res = makeRes();
    await postSiteNoteCreateHandler(
      {
        currentUser: USER,
        currentTenant: { id: TENANT_A },
        language: 'en',
        params: { tenantId: TENANT_A, id: 'ps-9' },
        body: { title: 'x' },
      } as any,
      res,
      () => undefined,
    );

    assert.strictEqual(res.statusCode, 400);
  });
});
