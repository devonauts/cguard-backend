/**
 * Unit tests — CRUD persistence fidelity for the g07-patrols group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - patrolRepository create/update/destroy      (field fidelity, where target,
 *                                                  cross-tenant 404, associations)
 *   - patrolService create/update                 (db error NOT swallowed,
 *                                                  supervisorId compat mapping)
 *   - patrolCheckpointRepository create/update    (field fidelity, QR file relation)
 *   - patrolLogRepository create/update           (field fidelity, false booleans)
 *   - siteTour.ts handlers (rondas)               (POST/PUT/PATCH tour + tag,
 *                                                  whitelist, mass-assignment,
 *                                                  db failure → 500 not success)
 *   - siteTourService assignGuard/updateAssignment (fidelity, tenant where,
 *                                                  rollback on failure)
 *   - rondaSettings PUT upsert                    (every FIELDS key persisted,
 *                                                  keyed by tenant+postSite,
 *                                                  db failure → error response)
 *
 * recordTagScan already has its own suite (tests/unit/patrols-rondas).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g07-patrols/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import PatrolRepository from '../../../src/database/repositories/patrolRepository';
import PatrolCheckpointRepository from '../../../src/database/repositories/patrolCheckpointRepository';
import PatrolLogRepository from '../../../src/database/repositories/patrolLogRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import UserRepository from '../../../src/database/repositories/userRepository';
import StationRepository from '../../../src/database/repositories/stationRepository';
import Error404 from '../../../src/errors/Error404';

import PatrolService from '../../../src/services/patrolService';
import SiteTourService from '../../../src/services/siteTourService';

import siteTourRoutes from '../../../src/api/siteTour';
import rondaSettingsRoutes from '../../../src/api/rondaSettings';

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
    __assoc: {} as Record<string, any[]>,
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
      // Sequelize semantics: undefined values are ignored by set().
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) row[k] = v;
      }
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    async reload() {
      return row;
    },
  };
  // Association setters/getters the patrol repos call (record set calls).
  for (const name of ['Checkpoints', 'Logs', 'Patrols']) {
    row[`set${name}`] = async (ids: any) => {
      row.__assoc[`set${name}`] = row.__assoc[`set${name}`] || [];
      row.__assoc[`set${name}`].push(ids);
      return row;
    };
    row[`get${name}`] = async () => row.__assoc[`stored${name}`] || [];
  }
  row.getAssignedQrImage = async () => [];
  return row;
}

/** Where matcher supporting plain equality + Op.ne / Op.in / Op.and. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
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

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[], destroy: [] as any[] },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data, deletedAt: null });
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

function makeTx() {
  const tx: any = { committed: false, rolledBack: false };
  tx.commit = async () => { tx.committed = true; };
  tx.rollback = async () => { tx.rolledBack = true; };
  return tx;
}

function buildDb(seed: {
  patrols?: any[];
  patrolCheckpoints?: any[];
  patrolLogs?: any[];
  siteTours?: any[];
  siteTourTags?: any[];
  tourAssignments?: any[];
  rondaSettings?: any[];
} = {}) {
  const txs: any[] = [];
  const db: any = {
    __txs: txs,
    patrol: makeModel('patrol', seed.patrols || []),
    patrolCheckpoint: makeModel('patrolCheckpoint', seed.patrolCheckpoints || []),
    patrolLog: makeModel('patrolLog', seed.patrolLogs || []),
    siteTour: makeModel('siteTour', seed.siteTours || []),
    siteTourTag: makeModel('siteTourTag', seed.siteTourTags || []),
    tourAssignment: makeModel('tourAssignment', seed.tourAssignments || []),
    rondaSettings: makeModel('rondaSettings', seed.rondaSettings || []),
    securityGuard: makeModel('securityGuard', []),
    user: makeModel('user', []),
    station: makeModel('station', []),
    tenantUser: makeModel('tenantUser', []),
    businessInfo: makeModel('businessInfo', []),
    clientAccount: makeModel('clientAccount', []),
    file: makeModel('file', []),
    sequelize: {
      // Supports both styles: `await tx = transaction()` AND the managed
      // callback form `transaction(async (t) => {...})` used by siteTour.
      async transaction(fn?: any) {
        const tx = makeTx();
        txs.push(tx);
        if (typeof fn === 'function') return fn(tx);
        return tx;
      },
    },
  };
  return db;
}

// Admin user: passes PermissionChecker and the patrol repos' customer-ACL
// admin check (so the ACL block does not interfere with the CRUD assertions).
function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    email: 'admin@test.ec',
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
  res.setHeader = () => res;
  return res;
}

/** Register the express-style routes into a captured map: 'METHOD path' → handler. */
function captureRoutes(registrar: (r: any) => void) {
  const routes: Record<string, Function> = {};
  const capture = (method: string) => (path: string, handler: Function) => {
    routes[`${method} ${path}`] = handler;
  };
  const router: any = {
    get: capture('GET'),
    post: capture('POST'),
    put: capture('PUT'),
    patch: capture('PATCH'),
    delete: capture('DELETE'),
  };
  registrar(router);
  return routes;
}

const assertSubset = (actual: any, expected: Record<string, any>, label = '') => {
  for (const [k, v] of Object.entries(expected)) {
    assert.deepStrictEqual(actual[k], v, `${label}field "${k}": expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
  }
};

// Cross-cutting side channels are not the persistence under test.
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ patrolRepository ════════════════════════════════
describe('crud-g07 · patrolRepository.create', () => {
  // Every writable field the frontend patrol form can send.
  const FULL_CREATE = {
    scheduledTime: '2026-07-14T20:00:00.000Z',
    completed: true,
    completionTime: '2026-07-14T21:30:00.000Z',
    status: 'Completed',
    importHash: 'hash-p1',
    assignedGuard: 'guard-7',
    station: 'st-9',
    checkpoints: ['cp-1', 'cp-2'],
    logs: ['log-1'],
  };

  it('persists EVERY scalar field + relation ids + tenant/audit stamps', async () => {
    const db = buildDb();
    await PatrolRepository.create({ ...FULL_CREATE }, repoOptions(db));

    assert.strictEqual(db.patrol.calls.create.length, 1, 'exactly one insert');
    assertSubset(db.patrol.calls.create[0], {
      scheduledTime: FULL_CREATE.scheduledTime,
      completed: true,
      completionTime: FULL_CREATE.completionTime,
      status: 'Completed',
      importHash: 'hash-p1',
      assignedGuardId: 'guard-7',
      stationId: 'st-9',
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
  });

  it('wires the checkpoints and logs associations with the given ids', async () => {
    const db = buildDb();
    await PatrolRepository.create({ ...FULL_CREATE }, repoOptions(db));
    const row = db.patrol.rows[0];
    assert.deepStrictEqual(row.__assoc.setCheckpoints, [['cp-1', 'cp-2']]);
    assert.deepStrictEqual(row.__assoc.setLogs, [['log-1']]);
  });
});

describe('crud-g07 · patrolRepository.update', () => {
  const seedPatrol = (tenantId = TENANT) => ({
    id: 'p-1',
    scheduledTime: '2026-07-14T20:00:00.000Z',
    completed: false,
    completionTime: null,
    status: 'Incomplete',
    assignedGuardId: 'guard-7',
    stationId: 'st-9',
    tenantId,
    deletedAt: null,
  });

  const FULL_UPDATE = {
    scheduledTime: '2026-07-15T02:00:00.000Z',
    completed: true,
    completionTime: '2026-07-15T03:00:00.000Z',
    status: 'Completed',
    importHash: 'hash-p2',
    assignedGuard: 'guard-8',
    station: 'st-10',
    checkpoints: ['cp-3'],
    logs: ['log-2'],
  };

  it('targets the row by {id, tenantId} and applies EVERY field of the patch', async () => {
    const db = buildDb({ patrols: [seedPatrol()] });
    await PatrolRepository.update('p-1', { ...FULL_UPDATE }, repoOptions(db));

    // where-clause targets the right row *scoped to the tenant*
    const where = db.patrol.calls.findOne[0].where;
    assert.strictEqual(where.id, 'p-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.patrol.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1, 'exactly one update');
    assertSubset(row.__updateCalls[0], {
      scheduledTime: FULL_UPDATE.scheduledTime,
      completed: true,
      completionTime: FULL_UPDATE.completionTime,
      status: 'Completed',
      importHash: 'hash-p2',
      assignedGuardId: 'guard-8',
      stationId: 'st-10',
      updatedById: USER_ID,
    });
    // and the row actually changed
    assert.strictEqual(row.status, 'Completed');
    assert.strictEqual(row.assignedGuardId, 'guard-8');
    assert.deepStrictEqual(row.__assoc.setCheckpoints, [['cp-3']]);
    assert.deepStrictEqual(row.__assoc.setLogs, [['log-2']]);
  });

  it("throws 404 (never silent success) when the id belongs to ANOTHER tenant's patrol", async () => {
    const db = buildDb({ patrols: [seedPatrol(OTHER_TENANT)] });
    await assert.rejects(
      PatrolRepository.update('p-1', { ...FULL_UPDATE }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.patrol.rows[0].__updateCalls.length, 0, 'foreign row untouched');
  });

  // FIXED: patrolRepository.update presence-guards assignedGuardId/stationId
  // (undefined → not written) and only re-sets checkpoints/logs when the
  // payload carries them; PatrolService.update no longer sanitizes absent keys.
  it('a partial update (completed only) must NOT clear assignedGuardId/stationId/checkpoints', async () => {
    const db = buildDb({ patrols: [seedPatrol()] });
    await PatrolRepository.update('p-1', { completed: true }, repoOptions(db));
    const row = db.patrol.rows[0];
    assert.strictEqual(row.completed, true);
    assert.strictEqual(row.assignedGuardId, 'guard-7', 'guard must survive a partial update');
    assert.strictEqual(row.stationId, 'st-9', 'station must survive a partial update');
    assert.deepStrictEqual(row.__assoc.setCheckpoints, undefined, 'checkpoints must not be detached');
  });

  it('destroy targets only the tenant-scoped row (cross-tenant destroy → 404)', async () => {
    const db = buildDb({ patrols: [seedPatrol(OTHER_TENANT)] });
    await assert.rejects(
      PatrolRepository.destroy('p-1', repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.patrol.rows[0].__destroyed, false);
  });
});

// ═══════════════════════════ patrolService ═══════════════════════════════════
describe('crud-g07 · patrolService (error propagation + compat mapping)', () => {
  const identityStubs = () => {
    if ((UserRepository as any).filterIdInTenant?.restore) (UserRepository as any).filterIdInTenant.restore();
    sinon.stub(UserRepository, 'filterIdInTenant').callsFake(async (id: any) => id ?? null);
    if ((StationRepository as any).filterIdInTenant?.restore) (StationRepository as any).filterIdInTenant.restore();
    sinon.stub(StationRepository, 'filterIdInTenant').callsFake(async (id: any) => id ?? null);
    if ((PatrolCheckpointRepository as any).filterIdsInTenant?.restore) (PatrolCheckpointRepository as any).filterIdsInTenant.restore();
    sinon.stub(PatrolCheckpointRepository, 'filterIdsInTenant').callsFake(async (ids: any) => ids || []);
    if ((PatrolLogRepository as any).filterIdsInTenant?.restore) (PatrolLogRepository as any).filterIdsInTenant.restore();
    sinon.stub(PatrolLogRepository, 'filterIdsInTenant').callsFake(async (ids: any) => ids || []);
  };

  it('create: a db failure is rethrown (NOT swallowed) and the transaction rolls back', async () => {
    identityStubs();
    const db = buildDb();
    db.patrol.create = async () => { throw new Error('DB down'); };
    const service = new PatrolService(repoOptions(db));
    await assert.rejects(
      service.create({ scheduledTime: '2026-07-14T20:00:00.000Z', station: 'st-1' }),
      /DB down/,
    );
    assert.strictEqual(db.__txs.length, 1);
    assert.strictEqual(db.__txs[0].rolledBack, true, 'transaction must roll back');
    assert.strictEqual(db.__txs[0].committed, false);
  });

  it('update: a db failure is rethrown (NOT swallowed) and the transaction rolls back', async () => {
    identityStubs();
    const db = buildDb({
      patrols: [{ id: 'p-1', tenantId: TENANT, status: 'Incomplete', deletedAt: null }],
    });
    db.patrol.rows[0].update = async () => { throw new Error('write failed'); };
    const service = new PatrolService(repoOptions(db));
    await assert.rejects(service.update('p-1', { status: 'Completed' }), /write failed/);
    assert.strictEqual(db.__txs[0].rolledBack, true);
  });

  it('create maps the compat field supervisorId → assignedGuardId in the actual insert', async () => {
    identityStubs();
    const db = buildDb();
    const service = new PatrolService(repoOptions(db));
    await service.create({
      scheduledTime: '2026-07-14T20:00:00.000Z',
      supervisorId: 'sup-1',
      station: 'st-1',
    });
    assert.strictEqual(db.patrol.calls.create[0].assignedGuardId, 'sup-1');
    assert.strictEqual(db.__txs[0].committed, true);
  });
});

// ═══════════════════════ patrolCheckpointRepository ══════════════════════════
describe('crud-g07 · patrolCheckpointRepository', () => {
  const FULL_CREATE = {
    name: 'Portón Norte',
    latitud: -0.180653,
    longitud: -78.467838,
    importHash: 'hash-cp',
    station: 'st-9',
    patrols: ['p-1'],
    assignedQrImage: [{ id: 'file-1', name: 'qr.png' }],
  };

  it('create persists every field + relation ids + QR file relation + stamps', async () => {
    const db = buildDb();
    await PatrolCheckpointRepository.create({ ...FULL_CREATE }, repoOptions(db));

    assertSubset(db.patrolCheckpoint.calls.create[0], {
      name: 'Portón Norte',
      latitud: -0.180653,
      longitud: -78.467838,
      importHash: 'hash-cp',
      stationId: 'st-9',
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
    assert.deepStrictEqual(db.patrolCheckpoint.rows[0].__assoc.setPatrols, [['p-1']]);

    // The QR image must be forwarded to the file-relation writer, not dropped.
    const frStub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    assert.ok(frStub.calledOnce, 'replaceRelationFiles must be called');
    assert.deepStrictEqual(frStub.firstCall.args[1], FULL_CREATE.assignedQrImage);
    assert.strictEqual(frStub.firstCall.args[0].belongsToColumn, 'assignedQrImage');
  });

  it('update targets {id, tenantId} and applies every field', async () => {
    const db = buildDb({
      patrolCheckpoints: [{ id: 'cp-1', name: 'Viejo', latitud: 0, longitud: 0, stationId: 'st-1', tenantId: TENANT, deletedAt: null }],
    });
    await PatrolCheckpointRepository.update(
      'cp-1',
      { name: 'Nuevo', latitud: -1.5, longitud: -79.1, importHash: 'h2', station: 'st-2', patrols: ['p-9'] },
      repoOptions(db),
    );

    const where = db.patrolCheckpoint.calls.findOne[0].where;
    assert.strictEqual(where.id, 'cp-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.patrolCheckpoint.rows[0];
    assertSubset(row.__updateCalls[0], {
      name: 'Nuevo',
      latitud: -1.5,
      longitud: -79.1,
      importHash: 'h2',
      stationId: 'st-2',
      updatedById: USER_ID,
    });
    assert.strictEqual(row.name, 'Nuevo');
    assert.deepStrictEqual(row.__assoc.setPatrols, [['p-9']]);
  });

  it("cross-tenant update → 404, other tenant's checkpoint untouched", async () => {
    const db = buildDb({
      patrolCheckpoints: [{ id: 'cp-1', name: 'Ajeno', tenantId: OTHER_TENANT, deletedAt: null }],
    });
    await assert.rejects(
      PatrolCheckpointRepository.update('cp-1', { name: 'Robado' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.patrolCheckpoint.rows[0].name, 'Ajeno');
  });

  // FIXED: patrolCheckpointRepository.update presence-guards stationId and
  // only re-sets patrols / replaces the QR file relation when the payload
  // carries those keys.
  it('a rename-only update must NOT clear stationId', async () => {
    const db = buildDb({
      patrolCheckpoints: [{ id: 'cp-1', name: 'Viejo', stationId: 'st-1', tenantId: TENANT, deletedAt: null }],
    });
    await PatrolCheckpointRepository.update('cp-1', { name: 'Nuevo' }, repoOptions(db));
    assert.strictEqual(db.patrolCheckpoint.rows[0].stationId, 'st-1');
  });
});

// ═══════════════════════════ patrolLogRepository ═════════════════════════════
describe('crud-g07 · patrolLogRepository', () => {
  const FULL_CREATE = {
    scanTime: '2026-07-14T22:15:00.000Z',
    latitude: -0.18,
    longitude: -78.46,
    validLocation: false, // deliberately falsy — must NOT be dropped
    status: '"Scanned"',
    importHash: 'hash-log',
    patrol: 'p-1',
    scannedBy: 'guard-7',
  };

  it('create persists every field — including a FALSE boolean — plus stamps', async () => {
    const db = buildDb();
    await PatrolLogRepository.create({ ...FULL_CREATE }, repoOptions(db));

    assertSubset(db.patrolLog.calls.create[0], {
      scanTime: FULL_CREATE.scanTime,
      latitude: -0.18,
      longitude: -78.46,
      validLocation: false,
      status: '"Scanned"',
      importHash: 'hash-log',
      patrolId: 'p-1',
      scannedById: 'guard-7',
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
  });

  it('update targets {id, tenantId} and applies every field', async () => {
    const db = buildDb({
      patrolLogs: [{
        id: 'log-1', scanTime: '2026-07-14T22:00:00.000Z', latitude: 0, longitude: 0,
        validLocation: true, status: '"Pending"', patrolId: 'p-1', scannedById: 'guard-7',
        tenantId: TENANT, deletedAt: null,
      }],
    });
    await PatrolLogRepository.update(
      'log-1',
      {
        scanTime: '2026-07-14T23:00:00.000Z',
        latitude: -0.2,
        longitude: -78.5,
        validLocation: false,
        status: '"Missed"',
        importHash: 'h3',
        patrol: 'p-2',
        scannedBy: 'guard-8',
      },
      repoOptions(db),
    );

    const where = db.patrolLog.calls.findOne[0].where;
    assert.strictEqual(where.id, 'log-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.patrolLog.rows[0];
    assertSubset(row.__updateCalls[0], {
      scanTime: '2026-07-14T23:00:00.000Z',
      latitude: -0.2,
      longitude: -78.5,
      validLocation: false,
      status: '"Missed"',
      importHash: 'h3',
      patrolId: 'p-2',
      scannedById: 'guard-8',
      updatedById: USER_ID,
    });
    assert.strictEqual(row.status, '"Missed"');
  });

  it('cross-tenant update → 404', async () => {
    const db = buildDb({
      patrolLogs: [{ id: 'log-1', status: '"Pending"', tenantId: OTHER_TENANT, deletedAt: null }],
    });
    await assert.rejects(
      PatrolLogRepository.update('log-1', { status: '"Scanned"' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
  });

  // FIXED: patrolLogRepository.update presence-guards patrolId/scannedById
  // (undefined → not written) so a partial update keeps the parent patrol
  // and the scanner.
  it('a status-only update must NOT clear patrolId/scannedById', async () => {
    const db = buildDb({
      patrolLogs: [{ id: 'log-1', status: '"Pending"', patrolId: 'p-1', scannedById: 'guard-7', tenantId: TENANT, deletedAt: null }],
    });
    await PatrolLogRepository.update('log-1', { status: '"Scanned"' }, repoOptions(db));
    const row = db.patrolLog.rows[0];
    assert.strictEqual(row.patrolId, 'p-1');
    assert.strictEqual(row.scannedById, 'guard-7');
  });
});

// ═══════════════════════ siteTour.ts handlers (rondas) ═══════════════════════
describe('crud-g07 · siteTour handlers (rondas CRUD)', () => {
  const routes = captureRoutes(siteTourRoutes);

  const FULL_TOUR_BODY = {
    name: 'Ronda Nocturna',
    description: 'Perímetro completo',
    scheduledDays: ['mon', 'wed', 'fri'],
    postSiteId: 'ps-1',
    stationId: 'st-1',
    securityGuardId: 'sg-1',
    continuous: true,
    timeMode: 'window',
    selectTime: '22:00',
    maxDuration: '45',
    active: false, // deliberately false — must NOT default back to true
  };

  it('POST /site-tour persists EVERY field of the payload + tenant/audit stamps', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { ...FULL_TOUR_BODY } });
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour'](req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assertSubset(db.siteTour.calls.create[0], {
      name: 'Ronda Nocturna',
      description: 'Perímetro completo',
      scheduledDays: ['mon', 'wed', 'fri'],
      postSiteId: 'ps-1',
      stationId: 'st-1',
      securityGuardId: 'sg-1',
      continuous: true,
      timeMode: 'window',
      selectTime: '22:00',
      maxDuration: '45',
      active: false,
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
  });

  it('POST /site-tour with securityGuardId also persists the initial tourAssignment', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { ...FULL_TOUR_BODY } });
    await routes['POST /tenant/:tenantId/site-tour'](req, fakeRes());

    assert.strictEqual(db.tourAssignment.calls.create.length, 1, 'assignment insert expected');
    assertSubset(db.tourAssignment.calls.create[0], {
      siteTourId: db.siteTour.rows[0].id,
      securityGuardId: 'sg-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
      tenantId: TENANT,
    });
  });

  // FIXED: the initial-assignment insert is no longer wrapped in a swallowing
  // try/catch — a failure surfaces as an error instead of a success that
  // claims the guard was assigned.
  it('POST /site-tour: a tourAssignment insert failure surfaces as an error, NOT fake success', async () => {
    const db = buildDb();
    db.tourAssignment.create = async () => { throw new Error('assignment insert failed'); };
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour'](fakeReq(db, { body: { ...FULL_TOUR_BODY } }), res);
    assert.strictEqual(res.statusCode, 500, 'assignment failure must not be swallowed into success');
  });

  it('POST /site-tour without stationId → 400 and NOTHING is created', async () => {
    const db = buildDb();
    const body: any = { ...FULL_TOUR_BODY };
    delete body.stationId;
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour'](fakeReq(db, { body }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.siteTour.calls.create.length, 0);
  });

  it('POST /site-tour: a db failure surfaces as a 500 error, NOT a fake success', async () => {
    const db = buildDb();
    db.siteTour.create = async () => { throw new Error('insert failed'); };
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour'](fakeReq(db, { body: { ...FULL_TOUR_BODY } }), res);
    assert.strictEqual(res.statusCode, 500, 'db failure must not be swallowed into success');
  });

  const seedTour = (tenantId = TENANT) => ({
    id: 'tour-1',
    name: 'Ronda Vieja',
    description: 'desc',
    scheduledDays: ['mon'],
    postSiteId: 'ps-1',
    stationId: 'st-1',
    securityGuardId: 'sg-1',
    continuous: false,
    timeMode: 'fixed',
    selectTime: '08:00',
    maxDuration: '30',
    active: true,
    tenantId,
    deletedAt: null,
  });

  it('PUT /site-tour/:id targets {id, tenantId} and applies EVERY field incl. reassignment', async () => {
    const db = buildDb({ siteTours: [seedTour()] });
    const body = {
      name: 'Ronda Nueva',
      description: 'nueva desc',
      scheduledDays: ['tue', 'thu'],
      stationId: 'st-2',
      securityGuardId: 'sg-2',
      postSiteId: 'ps-2',
      continuous: true,
      timeMode: 'window',
      selectTime: '23:00',
      maxDuration: '60',
      active: false,
    };
    const res = fakeRes();
    await routes['PUT /tenant/:tenantId/site-tour/:id'](
      fakeReq(db, { params: { id: 'tour-1' }, body }),
      res,
    );

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const where = db.siteTour.calls.findOne[0].where;
    assert.strictEqual(where.id, 'tour-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.siteTour.rows[0];
    assertSubset(row, {
      name: 'Ronda Nueva',
      description: 'nueva desc',
      scheduledDays: ['tue', 'thu'],
      stationId: 'st-2',
      securityGuardId: 'sg-2',
      postSiteId: 'ps-2',
      continuous: true,
      timeMode: 'window',
      selectTime: '23:00',
      maxDuration: '60',
      active: false,
      updatedById: USER_ID,
    }, 'PUT ');
  });

  it("PUT on another tenant's tour → 404, foreign row untouched", async () => {
    const db = buildDb({ siteTours: [seedTour(OTHER_TENANT)] });
    const res = fakeRes();
    await routes['PUT /tenant/:tenantId/site-tour/:id'](
      fakeReq(db, { params: { id: 'tour-1' }, body: { name: 'Robada' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.siteTour.rows[0].name, 'Ronda Vieja');
  });

  it('PATCH /site-tour/:id applies whitelisted fields and BLOCKS tenantId/id mass-assignment', async () => {
    const db = buildDb({ siteTours: [seedTour()] });
    const res = fakeRes();
    await routes['PATCH /tenant/:tenantId/site-tour/:id'](
      fakeReq(db, {
        params: { id: 'tour-1' },
        body: {
          name: 'Parche',
          active: false,
          maxDuration: '90',
          tenantId: 'tenant-EVIL',
          id: 'hijack',
          createdById: 'evil-user',
        },
      }),
      res,
    );
    assert.strictEqual(res.statusCode, 200);
    const row = db.siteTour.rows[0];
    assert.strictEqual(row.name, 'Parche');
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.maxDuration, '90');
    // untouched fields survive a partial PATCH
    assert.strictEqual(row.securityGuardId, 'sg-1');
    assert.strictEqual(row.stationId, 'st-1');
    // injected columns must be rejected
    assert.strictEqual(row.tenantId, TENANT, 'tenantId must not be mass-assignable');
    assert.strictEqual(row.id, 'tour-1');
    assert.notStrictEqual(row.createdById, 'evil-user');
  });

  it('DELETE /site-tour/:id is tenant-scoped (cross-tenant delete → 404, row survives)', async () => {
    const db = buildDb({ siteTours: [seedTour(OTHER_TENANT)] });
    const res = fakeRes();
    await routes['DELETE /tenant/:tenantId/site-tour/:id'](
      fakeReq(db, { params: { id: 'tour-1' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.siteTour.rows[0].__destroyed, false);
  });

  // ── siteTourTag (checkpoints of a ronda) ───────────────────────────────────
  it('POST tag persists every field, coerces geofenceRadius and inherits the tour station', async () => {
    const db = buildDb({ siteTours: [seedTour()] });
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour/:tourId/tag'](
      fakeReq(db, {
        params: { tourId: 'tour-1' },
        body: {
          name: 'QR Garita',
          tagType: 'qr',
          tagIdentifier: 'TAG-001',
          location: 'Garita principal',
          instructions: 'Verificar candado',
          latitude: -0.19,
          longitude: -78.48,
          showGeoFence: true,
          geofenceRadius: '75', // string from the app — must persist as number
          // no stationId in body → must inherit tour.stationId
        },
      }),
      res,
    );

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assertSubset(db.siteTourTag.calls.create[0], {
      name: 'QR Garita',
      tagType: 'qr',
      tagIdentifier: 'TAG-001',
      location: 'Garita principal',
      instructions: 'Verificar candado',
      latitude: -0.19,
      longitude: -78.48,
      showGeoFence: true,
      geofenceRadius: 75,
      siteTourId: 'tour-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
  });

  it('POST tag with a duplicate tagIdentifier in the tenant → 400, no insert', async () => {
    const db = buildDb({
      siteTours: [seedTour()],
      siteTourTags: [{ id: 'tag-1', tagIdentifier: 'TAG-001', siteTourId: 'tour-1', tenantId: TENANT, deletedAt: null }],
    });
    const res = fakeRes();
    await routes['POST /tenant/:tenantId/site-tour/:tourId/tag'](
      fakeReq(db, { params: { tourId: 'tour-1' }, body: { name: 'Dup', tagIdentifier: 'TAG-001' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.siteTourTag.calls.create.length, 0);
  });

  it('PATCH tag applies whitelisted fields, blocks tenantId, targets the tenant-scoped tag', async () => {
    const db = buildDb({
      siteTours: [seedTour()],
      siteTourTags: [{
        id: 'tag-1', name: 'QR Viejo', tagType: 'qr', tagIdentifier: 'TAG-001',
        location: 'x', instructions: null, latitude: 0, longitude: 0,
        showGeoFence: false, geofenceRadius: 50, siteTourId: 'tour-1',
        postSiteId: 'ps-1', stationId: 'st-1', tenantId: TENANT, deletedAt: null,
      }],
    });
    const res = fakeRes();
    await routes['PATCH /tenant/:tenantId/site-tour/:tourId/tag/:tagId'](
      fakeReq(db, {
        params: { tourId: 'tour-1', tagId: 'tag-1' },
        body: {
          name: 'QR Nuevo',
          tagType: 'nfc',
          tagIdentifier: 'TAG-002',
          location: 'Bodega',
          instructions: 'Foto obligatoria',
          latitude: -1.1,
          longitude: -79.2,
          showGeoFence: true,
          geofenceRadius: 120,
          postSiteId: 'ps-2',
          stationId: 'st-2',
          tenantId: 'tenant-EVIL',
        },
      }),
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    const where = db.siteTourTag.calls.findOne[0].where;
    assert.strictEqual(where.id, 'tag-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.siteTourTag.rows[0];
    assertSubset(row, {
      name: 'QR Nuevo',
      tagType: 'nfc',
      tagIdentifier: 'TAG-002',
      location: 'Bodega',
      instructions: 'Foto obligatoria',
      latitude: -1.1,
      longitude: -79.2,
      showGeoFence: true,
      geofenceRadius: 120,
      postSiteId: 'ps-2',
      stationId: 'st-2',
    }, 'PATCH tag ');
    assert.strictEqual(row.tenantId, TENANT, 'tenantId must not be mass-assignable');
  });
});

// ═══════════════════════════ siteTourService ═════════════════════════════════
describe('crud-g07 · siteTourService assignments', () => {
  const svcOptions = (db: any) => ({
    database: db,
    currentTenant: { id: TENANT },
    currentUser: adminUser(),
    language: 'es',
  }) as any;

  it('assignGuard persists every payload field + tenant/audit stamps and commits', async () => {
    const db = buildDb();
    const service = new SiteTourService(svcOptions(db));
    await service.assignGuard('tour-1', 'sg-1', {
      startAt: '2026-07-14T20:00:00.000Z',
      endAt: '2026-07-15T06:00:00.000Z',
      status: 'in_progress',
      stationId: 'st-1',
      postSiteId: 'ps-1',
    });

    assertSubset(db.tourAssignment.calls.create[0], {
      siteTourId: 'tour-1',
      securityGuardId: 'sg-1',
      startAt: '2026-07-14T20:00:00.000Z',
      endAt: '2026-07-15T06:00:00.000Z',
      status: 'in_progress',
      stationId: 'st-1',
      postSiteId: 'ps-1',
      tenantId: TENANT,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
    assert.strictEqual(db.__txs[0].committed, true);
  });

  it('updateAssignment applies every allowed field, targets {id, tenantId}, blocks tenantId', async () => {
    const db = buildDb({
      tourAssignments: [{
        id: 'as-1', siteTourId: 'tour-1', securityGuardId: 'sg-1', status: 'assigned',
        startAt: null, endAt: null, stationId: 'st-1', postSiteId: 'ps-1',
        tenantId: TENANT, deletedAt: null,
      }],
    });
    const service = new SiteTourService(svcOptions(db));
    await service.updateAssignment('as-1', {
      startAt: '2026-07-14T21:00:00.000Z',
      endAt: '2026-07-15T05:00:00.000Z',
      status: 'completed',
      securityGuardId: 'sg-2',
      postSiteId: 'ps-2',
      stationId: 'st-2',
      importHash: 'ih-1',
      tenantId: 'tenant-EVIL', // must be ignored (not whitelisted)
    });

    const where = db.tourAssignment.calls.findOne[0].where;
    assert.strictEqual(where.id, 'as-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.tourAssignment.rows[0];
    assertSubset(row.__updateCalls[0], {
      startAt: '2026-07-14T21:00:00.000Z',
      endAt: '2026-07-15T05:00:00.000Z',
      status: 'completed',
      securityGuardId: 'sg-2',
      postSiteId: 'ps-2',
      stationId: 'st-2',
      importHash: 'ih-1',
      updatedById: USER_ID,
    });
    assert.strictEqual(row.tenantId, TENANT, 'tenantId must not be mass-assignable');
    assert.strictEqual(db.__txs[0].committed, true);
  });

  it("updateAssignment on another tenant's row → 404 + rollback (no silent success)", async () => {
    const db = buildDb({
      tourAssignments: [{ id: 'as-1', status: 'assigned', tenantId: OTHER_TENANT, deletedAt: null }],
    });
    const service = new SiteTourService(svcOptions(db));
    await assert.rejects(service.updateAssignment('as-1', { status: 'completed' }), (e: any) => e.code === 404);
    assert.strictEqual(db.__txs[0].rolledBack, true);
    assert.strictEqual(db.tourAssignment.rows[0].status, 'assigned');
  });

  it('updateAssignment: a db write failure is rethrown and rolls back', async () => {
    const db = buildDb({
      tourAssignments: [{ id: 'as-1', status: 'assigned', tenantId: TENANT, deletedAt: null }],
    });
    db.tourAssignment.rows[0].update = async () => { throw new Error('write failed'); };
    const service = new SiteTourService(svcOptions(db));
    await assert.rejects(service.updateAssignment('as-1', { status: 'completed' }), /write failed/);
    assert.strictEqual(db.__txs[0].rolledBack, true);
  });
});

// ═══════════════════════════ rondaSettings PUT ═══════════════════════════════
describe('crud-g07 · rondaSettings upsert', () => {
  const routes = captureRoutes(rondaSettingsRoutes);
  const PUT = routes['PUT /tenant/:tenantId/ronda-settings'];

  // Every editable field of the settings form — all set AWAY from the defaults
  // so a dropped field cannot hide behind its default value.
  const FULL_SETTINGS = {
    frequencyMinutes: 30,
    roundsPerShift: 4,
    graceMinutes: 5,
    maxDurationMinutes: 45,
    requirePhoto: false,
    requireGeofence: false,
    geofenceRadius: 120,
    requireNote: true,
    notifyTenantOnStart: false,
    notifyTenantOnComplete: false,
    notifyTenantOnMissed: false,
    notifyClient: true,
    emailOnComplete: true,
    active: false,
  };

  it('creates the tenant default row with EVERY submitted field + stamps', async () => {
    const db = buildDb();
    const res = fakeRes();
    await PUT(fakeReq(db, { body: { ...FULL_SETTINGS } }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.rondaSettings.calls.create.length, 1);
    assertSubset(db.rondaSettings.calls.create[0], {
      ...FULL_SETTINGS,
      tenantId: TENANT,
      postSiteId: null,
      createdById: USER_ID,
      updatedById: USER_ID,
    });
  });

  it('updates the EXISTING row (keyed by tenantId+postSiteId) with every field', async () => {
    const db = buildDb({
      rondaSettings: [{
        id: 'rs-1', tenantId: TENANT, postSiteId: null,
        frequencyMinutes: 60, roundsPerShift: null, graceMinutes: 10, maxDurationMinutes: 60,
        requirePhoto: true, requireGeofence: true, geofenceRadius: 50, requireNote: false,
        notifyTenantOnStart: true, notifyTenantOnComplete: true, notifyTenantOnMissed: true,
        notifyClient: false, emailOnComplete: false, active: true, deletedAt: null,
      }],
    });
    const res = fakeRes();
    await PUT(fakeReq(db, { body: { ...FULL_SETTINGS } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.rondaSettings.calls.create.length, 0, 'must update, not duplicate');
    const where = db.rondaSettings.calls.findOne[0].where;
    assert.strictEqual(where.tenantId, TENANT);
    assert.strictEqual(where.postSiteId, null);

    const row = db.rondaSettings.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    assertSubset(row.__updateCalls[0], { ...FULL_SETTINGS, tenantId: TENANT, updatedById: USER_ID });
    // false booleans really landed on the row
    assert.strictEqual(row.requirePhoto, false);
    assert.strictEqual(row.notifyTenantOnMissed, false);
    assert.strictEqual(row.active, false);
  });

  it('a per-post override upserts under that postSiteId (not the tenant default)', async () => {
    const db = buildDb();
    const res = fakeRes();
    await PUT(fakeReq(db, { body: { ...FULL_SETTINGS, postSiteId: 'ps-9' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.rondaSettings.calls.create[0].postSiteId, 'ps-9');
    assert.strictEqual(db.rondaSettings.calls.findOne[0].where.postSiteId, 'ps-9');
  });

  it('a db failure surfaces as an error response, NOT a fake success', async () => {
    const db = buildDb();
    db.rondaSettings.findOne = async () => { throw new Error('DB down'); };
    const res = fakeRes();
    await PUT(fakeReq(db, { body: { ...FULL_SETTINGS } }), res);
    assert.strictEqual(res.statusCode, 500, 'db failure must not be swallowed into success');
  });
});
