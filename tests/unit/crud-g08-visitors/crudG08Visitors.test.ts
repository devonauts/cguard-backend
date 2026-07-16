/**
 * Unit tests — CRUD persistence fidelity for the g08-visitors group:
 *   visitorLog, visitorPreAuth, passdown (shiftPassdown), memos.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - VisitorLogRepository create/update      (field fidelity, where target,
 *                                              exitTime normalization,
 *                                              partial-update field wipes)
 *   - VisitorLogService                        (db error NOT swallowed)
 *   - MemosRepository create/update + MemosService (guardName round-trip,
 *                                              partial-update wipe, db error)
 *   - shiftPassdownService createPassdown / getIncomingForGuard
 *   - customerVisitorPreAuthCreate + visitorPreAuthScan handlers
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g08-visitors/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import VisitorLogRepository from '../../../src/database/repositories/visitorLogRepository';
import VisitorLogService from '../../../src/services/visitorLogService';
import MemosRepository from '../../../src/database/repositories/memosRepository';
import MemosService from '../../../src/services/memosService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error404 from '../../../src/errors/Error404';

import {
  createPassdown,
  getIncomingForGuard,
  deriveShiftKind,
} from '../../../src/services/shiftPassdownService';

import { customerVisitorPreAuthCreate } from '../../../src/api/customer/customerVisitorPreAuth';
import visitorPreAuthScan from '../../../src/api/visitorPreAuth/visitorPreAuthScan';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    __updateCalls: [] as any[],
    __saveCalls: 0,
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
      row.__saveCalls += 1;
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    // memos.findById hydrates the PDF relation through the association getter.
    async getMemoDocumentPdf() {
      return [];
    },
  };
  return row;
}

/** Where matcher supporting plain equality + Op.ne/in/gte/lte/and/or. */
function matchWhere(row: any, where: any): boolean {
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
    if (typeof key === 'symbol') continue; // other operators unused here
    const val = row[key as string];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && String(val) === String(v)) return false;
          if (s === Op.in && !(Array.isArray(v) && v.map(String).includes(String(val)))) return false;
          if (s === Op.gte && !(new Date(val).getTime() >= new Date(v).getTime())) return false;
          if (s === Op.lte && !(new Date(val).getTime() <= new Date(v).getTime())) return false;
        }
        continue;
      }
    }
    if (cond === null) {
      if (val !== null && val !== undefined) return false;
    } else if (String(val) !== String(cond)) {
      return false;
    }
  }
  return true;
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[] },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, deletedAt: null, ...data });
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
      return model.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async count() {
      return model.rows.length;
    },
  };
  return model;
}

function buildDb(seed: {
  visitorLogs?: any[];
  memos?: any[];
  securityGuards?: any[];
  stations?: any[];
  businessInfos?: any[];
  clientAccounts?: any[];
  shiftPassdowns?: any[];
  tasks?: any[];
  visitorPreAuths?: any[];
  shifts?: any[];
  guardShifts?: any[];
  tenantUsers?: any[];
} = {}) {
  const txns: any[] = [];
  const db: any = {
    Sequelize,
    __txns: txns,
    sequelize: {
      async transaction() {
        const t: any = { committed: 0, rolledBack: 0 };
        t.commit = async () => { t.committed += 1; };
        t.rollback = async () => { t.rolledBack += 1; };
        txns.push(t);
        return t;
      },
    },
    visitorLog: makeModel('visitorLog', seed.visitorLogs || []),
    memos: makeModel('memos', seed.memos || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    station: makeModel('station', seed.stations || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    shiftPassdown: makeModel('shiftPassdown', seed.shiftPassdowns || []),
    task: makeModel('task', seed.tasks || []),
    visitorPreAuthorization: makeModel('visitorPreAuthorization', seed.visitorPreAuths || []),
    shift: makeModel('shift', seed.shifts || []),
    guardShift: makeModel('guardShift', seed.guardShifts || []),
    tenantUser: makeModel('tenantUser', seed.tenantUsers || []),
    user: makeModel('user', []),
    file: makeModel('file', []),
    auditLog: makeModel('auditLog', []),
    platformEvent: makeModel('platformEvent', []),
    notification: makeModel('notification', []),
  };
  return db;
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

// Admin req context (passes PermissionChecker on the free plan).
function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
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
  res.sendStatus = (c: number) => { res.statusCode = c; return res; };
  res.header = () => res;
  return res;
}

// Cross-cutting side channels (audit log + file relations) are not the
// persistence under test — stub them so they don't need their own harness.
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ visitorLog ══════════════════════════════════════

/**
 * Every field the repository whitelists on create/update (mirrors the CRM +
 * worker-app visitor form).
 */
const VISITOR_FULL = {
  visitDate: '2026-07-14T10:00:00.000Z',
  lastName: 'Paz',
  firstName: 'Luis',
  idNumber: '1712345678',
  reason: 'Entrega de paquete',
  exitTime: '2026-07-14T11:30:00.000Z',
  numPeople: 2,
  importHash: 'imp-001',
  clientId: 'ca-1',
  postSiteId: 'ps-1',
  stationId: 'st-1',
  stationName: 'Puesto Norte',
  placeType: 'Oficina',
  idType: 'cedula',
  personVisited: 'Gerente General',
  company: 'ACME Corp',
  vehiclePlate: 'PBA-1234',
  vehicleType: 'auto',
  phone: '0999123456',
  birthDate: '1990-05-05',
  idExpiry: '2030-01-01',
  tagNumber: 'T-09',
  archived: false,
};

/** The richer "Visitor Details" columns defined on the model. */
const VISITOR_DETAIL_FIELDS = {
  email: 'visitante@acme.com',
  issuingState: 'Pichincha',
  visitType: 'Business',
  department: 'Ventas',
  accessLevel: 'Level 2',
  expectedDuration: '2 hours',
  notes: 'Debe ser escoltado en todo momento',
  vehicleColor: 'rojo',
  vehicleMakeModel: 'Toyota Hilux',
  parkingLocation: 'Parqueadero B',
};

describe('crud-g08 · VisitorLogRepository.create', () => {
  it('persists EVERY whitelisted form field with the exact values + tenant/user stamps', async () => {
    const db = buildDb();
    const created = await VisitorLogRepository.create({ ...VISITOR_FULL }, repoOptions(db));

    assert.strictEqual(db.visitorLog.calls.create.length, 1);
    const written = db.visitorLog.calls.create[0];
    for (const [k, v] of Object.entries(VISITOR_FULL)) {
      assert.strictEqual(written[k], v, `create dropped/mangled field "${k}"`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    // The repo returns the stored row (bypassing the read ACL).
    assert.ok(created && created.id, 'create must return the stored record');
    assert.strictEqual(created.firstName, 'Luis');
  });

  // FIXED: the richer "Visitor Details" columns (migration z20260703d, rendered
  // by src/api/supervisor/visitorDetail.ts) are now whitelisted in the
  // create/update lodash.pick lists of VisitorLogRepository.
  it('persists the richer Visitor Details fields (email/notes/vehicle detail/…)', async () => {
    const db = buildDb();
    await VisitorLogRepository.create({ ...VISITOR_FULL, ...VISITOR_DETAIL_FIELDS }, repoOptions(db));
    const written = db.visitorLog.calls.create[0];
    for (const [k, v] of Object.entries(VISITOR_DETAIL_FIELDS)) {
      assert.strictEqual(written[k], v, `create dropped detail field "${k}"`);
    }
  });

  it('normalizes an empty exitTime to null on create (open visit)', async () => {
    const db = buildDb();
    await VisitorLogRepository.create({ ...VISITOR_FULL, exitTime: '' }, repoOptions(db));
    assert.strictEqual(db.visitorLog.calls.create[0].exitTime, null);
  });
});

describe('crud-g08 · VisitorLogRepository.update', () => {
  const seedRow = () => ({
    id: 'vl-1',
    tenantId: TENANT,
    ...VISITOR_FULL,
    deletedAt: null,
    createdById: 'someone-else',
  });

  it('targets the row by id + tenantId and applies EVERY whitelisted field', async () => {
    const db = buildDb({ visitorLogs: [seedRow()] });
    const patch = {
      ...VISITOR_FULL,
      firstName: 'Luisa',
      lastName: 'Paz Vega',
      reason: 'Retiro de equipo',
      exitTime: '2026-07-14T12:00:00.000Z',
      numPeople: 3,
      tagNumber: 'T-10',
      archived: true,
      stationName: 'Puesto Sur',
    };
    await VisitorLogRepository.update('vl-1', patch, repoOptions(db));

    // where targeted the right row
    const q = db.visitorLog.calls.findOne[0];
    assert.strictEqual(q.where.id, 'vl-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const row = db.visitorLog.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    const applied = row.__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.strictEqual(applied[k], v, `update dropped/mangled field "${k}"`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
    // and the row actually changed
    assert.strictEqual(row.firstName, 'Luisa');
    assert.strictEqual(row.archived, true);
  });

  it('a row belonging to ANOTHER tenant is not reachable (404, no silent no-op)', async () => {
    const db = buildDb({ visitorLogs: [{ ...seedRow(), tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => VisitorLogRepository.update('vl-1', { firstName: 'Hacker' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.visitorLog.rows[0].firstName, 'Luis', 'row must be untouched');
  });

  // FIXED: VisitorLogRepository.update only normalizes an EXPLICIT '' exitTime
  // to null; an absent key stays undefined so a partial patch (e.g. the archive
  // toggle) leaves the stored exit time untouched.
  it('a partial patch (archived only) must NOT wipe the stored exitTime', async () => {
    const db = buildDb({ visitorLogs: [seedRow()] });
    await VisitorLogRepository.update('vl-1', { archived: true }, repoOptions(db));
    const row = db.visitorLog.rows[0];
    assert.strictEqual(row.archived, true);
    assert.strictEqual(row.exitTime, VISITOR_FULL.exitTime, 'exitTime was wiped by a partial update');
  });

  it('a partial patch preserves the stored stationName (explicit keep-old logic)', async () => {
    const db = buildDb({ visitorLogs: [seedRow()] });
    await VisitorLogRepository.update('vl-1', { archived: true }, repoOptions(db));
    assert.strictEqual(db.visitorLog.rows[0].stationName, 'Puesto Norte');
  });
});

describe('crud-g08 · VisitorLogService error handling', () => {
  it('a db failure on create is NOT swallowed: rejects and rolls back', async () => {
    const db = buildDb();
    db.visitorLog.create = async () => { throw new Error('db down'); };
    const svc = new VisitorLogService(repoOptions(db));
    await assert.rejects(() => svc.create({ ...VISITOR_FULL, stationId: undefined, postSiteId: undefined, clientId: undefined }), /db down/);
    assert.strictEqual(db.__txns.length, 1);
    assert.strictEqual(db.__txns[0].rolledBack, 1, 'transaction must be rolled back');
    assert.strictEqual(db.__txns[0].committed, 0);
  });

  it('a db failure on update is NOT swallowed: rejects and rolls back', async () => {
    const db = buildDb({ visitorLogs: [{ id: 'vl-1', tenantId: TENANT, ...VISITOR_FULL, deletedAt: null }] });
    db.visitorLog.rows[0].update = async () => { throw new Error('write refused'); };
    const svc = new VisitorLogService(repoOptions(db));
    await assert.rejects(() => svc.update('vl-1', { firstName: 'X' }), /write refused/);
    assert.strictEqual(db.__txns[0].rolledBack, 1);
    assert.strictEqual(db.__txns[0].committed, 0);
  });
});

// ═══════════════════════════ memos ═══════════════════════════════════════════

const MEMO_FULL = {
  dateTime: '2026-07-14T08:00:00.000Z',
  subject: 'Uso obligatorio de chaleco',
  content: 'A partir de mañana el chaleco reflectivo es obligatorio en el turno nocturno.',
  wasAccepted: false,
  importHash: 'memo-imp-1',
};

describe('crud-g08 · MemosRepository.create', () => {
  it('persists every whitelisted field + guardName → guardNameId + stamps', async () => {
    const db = buildDb({ securityGuards: [{ id: 'sg-1', tenantId: TENANT, deletedAt: null }] });
    const created = await MemosRepository.create({ ...MEMO_FULL, guardName: 'sg-1' }, repoOptions(db));

    assert.strictEqual(db.memos.calls.create.length, 1);
    const written = db.memos.calls.create[0];
    for (const [k, v] of Object.entries(MEMO_FULL)) {
      assert.strictEqual(written[k], v, `create dropped/mangled field "${k}"`);
    }
    assert.strictEqual(written.guardNameId, 'sg-1', 'guardName must map to guardNameId');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    assert.ok(created && created.id);
  });

  it('a memo without a guard persists guardNameId = null (broadcast draft)', async () => {
    const db = buildDb();
    await MemosRepository.create({ ...MEMO_FULL }, repoOptions(db));
    assert.strictEqual(db.memos.calls.create[0].guardNameId, null);
  });
});

describe('crud-g08 · MemosRepository.update', () => {
  const seedMemo = () => ({
    id: 'memo-1',
    tenantId: TENANT,
    ...MEMO_FULL,
    guardNameId: 'sg-1',
    deletedAt: null,
  });

  it('targets id + tenantId and applies the full patch (incl. wasAccepted + guard change)', async () => {
    const db = buildDb({
      memos: [seedMemo()],
      securityGuards: [{ id: 'sg-2', tenantId: TENANT, deletedAt: null }],
    });
    const patch = {
      dateTime: '2026-07-15T09:00:00.000Z',
      subject: 'Actualización',
      content: 'Nuevo contenido',
      wasAccepted: true,
      importHash: 'memo-imp-2',
      guardName: 'sg-2',
    };
    await MemosRepository.update('memo-1', patch, repoOptions(db));

    const q = db.memos.calls.findOne[0];
    assert.strictEqual(q.where.id, 'memo-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const row = db.memos.rows[0];
    const applied = row.__updateCalls[0];
    assert.strictEqual(applied.dateTime, patch.dateTime);
    assert.strictEqual(applied.subject, patch.subject);
    assert.strictEqual(applied.content, patch.content);
    assert.strictEqual(applied.wasAccepted, true);
    assert.strictEqual(applied.importHash, patch.importHash);
    assert.strictEqual(applied.guardNameId, 'sg-2', 'guard reassignment must persist');
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual(row.subject, 'Actualización');
  });

  it('repository-level: omitting guardName leaves guardNameId untouched', async () => {
    const db = buildDb({ memos: [seedMemo()] });
    await MemosRepository.update('memo-1', { subject: 'Solo asunto' }, repoOptions(db));
    assert.strictEqual(db.memos.rows[0].guardNameId, 'sg-1');
    assert.strictEqual(db.memos.rows[0].subject, 'Solo asunto');
  });

  it('a memo of ANOTHER tenant is unreachable (404) and untouched', async () => {
    const db = buildDb({ memos: [{ ...seedMemo(), tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => MemosRepository.update('memo-1', { subject: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.memos.rows[0].subject, MEMO_FULL.subject);
  });
});

describe('crud-g08 · MemosService', () => {
  // FIXED: MemosService.update now runs the tenant pre-filter only when the
  // caller actually sent guardName; an omitted key no longer becomes an
  // explicit null-unassign in MemosRepository.update.
  it('a partial service update (no guardName sent) must NOT unassign the guard', async () => {
    const db = buildDb({
      memos: [{ id: 'memo-1', tenantId: TENANT, ...MEMO_FULL, guardNameId: 'sg-1', deletedAt: null }],
      securityGuards: [{ id: 'sg-1', tenantId: TENANT, deletedAt: null }],
    });
    const svc = new MemosService(repoOptions(db));
    await svc.update('memo-1', { subject: 'Nuevo asunto' });
    assert.strictEqual(db.memos.rows[0].guardNameId, 'sg-1', 'guardNameId was wiped by a partial update');
  });

  it('service create round-trips the addressed guard through the tenant filter', async () => {
    const db = buildDb({ securityGuards: [{ id: 'sg-1', tenantId: TENANT, deletedAt: null }] });
    const svc = new MemosService(repoOptions(db));
    await svc.create({ ...MEMO_FULL, guardName: 'sg-1' });
    assert.strictEqual(db.memos.calls.create[0].guardNameId, 'sg-1');
    assert.strictEqual(db.__txns[0].committed, 1);
  });

  it('a db failure on create is NOT swallowed: rejects and rolls back', async () => {
    const db = buildDb({ securityGuards: [{ id: 'sg-1', tenantId: TENANT, deletedAt: null }] });
    db.memos.create = async () => { throw new Error('db down'); };
    const svc = new MemosService(repoOptions(db));
    await assert.rejects(() => svc.create({ ...MEMO_FULL, guardName: 'sg-1' }), /db down/);
    assert.strictEqual(db.__txns[0].rolledBack, 1);
    assert.strictEqual(db.__txns[0].committed, 0);
  });
});

// ═══════════════════════════ passdown (shiftPassdown) ════════════════════════

describe('crud-g08 · shiftPassdownService.createPassdown', () => {
  const STATION = { id: 'st-1', stationName: 'Puesto Norte', postSiteId: 'ps-1' };
  const GUARD_SHIFT = {
    id: 'gs-1',
    shiftSchedule: 'Nocturno',
    scheduledStart: '2026-07-14T19:00:00.000Z',
    scheduledEnd: '2026-07-15T07:00:00.000Z', // 12h
  };

  it('persists the full guard handover: station, outgoing guard, shift meta, notes, count', async () => {
    const db = buildDb();
    const passdown = await createPassdown(db, TENANT, {
      station: STATION,
      channel: 'guard',
      guardShift: GUARD_SHIFT,
      outgoingUserId: 'user-out',
      outgoingSecurityGuardId: 'sg-out',
      outgoingGuardName: 'Juan Pérez',
      shiftSchedule: null, // must fall back to guardShift.shiftSchedule
      notes: '  Portón trasero con candado dañado  ',
      instructions: [
        { text: ' Revisar portón trasero ', priority: 'alta' },
        { text: '', priority: 'alta' }, // blank → filtered out
        { text: 'Entregar bitácora', priority: 'urgente' }, // invalid priority → media
      ],
    });

    const written = db.shiftPassdown.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.channel, 'guard');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.stationName, 'Puesto Norte');
    assert.strictEqual(written.postSiteId, 'ps-1');
    assert.strictEqual(written.outgoingGuardUserId, 'user-out');
    assert.strictEqual(written.outgoingSecurityGuardId, 'sg-out');
    assert.strictEqual(written.outgoingGuardName, 'Juan Pérez');
    assert.strictEqual(written.guardShiftId, 'gs-1');
    assert.strictEqual(written.shiftSchedule, 'Nocturno');
    assert.strictEqual(written.shiftKind, '12h');
    assert.strictEqual(written.notes, 'Portón trasero con candado dañado', 'notes must be trimmed, not dropped');
    assert.strictEqual(written.instructionCount, 2);
    assert.strictEqual(written.instructionsJson, null, 'guard-channel instructions live as tasks, not inline');
    assert.strictEqual(written.status, 'open');
    assert.ok(passdown && passdown.id);

    // Each instruction became an approved post-task with full fidelity.
    assert.strictEqual(db.task.calls.create.length, 2);
    const [t1, t2] = db.task.calls.create;
    assert.strictEqual(t1.taskToDo, 'Revisar portón trasero');
    assert.strictEqual(t1.priority, 'alta');
    assert.strictEqual(t2.taskToDo, 'Entregar bitácora');
    assert.strictEqual(t2.priority, 'media', 'invalid priority must normalize to media');
    for (const t of [t1, t2]) {
      assert.strictEqual(t.tenantId, TENANT);
      assert.strictEqual(t.taskBelongsToStationId, 'st-1');
      assert.strictEqual(t.status, 'approved');
      assert.strictEqual(t.source, 'passdown');
      assert.strictEqual(t.wasItDone, false);
      assert.strictEqual(t.passdownId, passdown.id);
      assert.strictEqual(t.createdById, 'user-out');
    }
  });

  it('supervisor handover: instructions persist INLINE (instructionsJson), no post-tasks', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, {
      station: null,
      channel: 'supervisor',
      outgoingUserId: 'user-sup',
      outgoingGuardName: 'Súper Visor',
      notes: 'Ronda completa sin novedad',
      instructions: [{ text: 'Verificar vehículo 12', priority: 'baja' }],
    });
    const written = db.shiftPassdown.calls.create[0];
    assert.strictEqual(written.channel, 'supervisor');
    assert.strictEqual(written.stationId, null);
    const inline = JSON.parse(written.instructionsJson);
    assert.deepStrictEqual(inline, [{ taskToDo: 'Verificar vehículo 12', priority: 'baja', wasItDone: false }]);
    assert.strictEqual(db.task.calls.create.length, 0, 'supervisor instructions must not create post-tasks');
  });

  it('blank notes persist as null (Sin novedad), never as empty string', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, { station: STATION, notes: '   ', instructions: [] });
    assert.strictEqual(db.shiftPassdown.calls.create[0].notes, null);
  });

  it('a db failure creating the passdown row is NOT swallowed by the service', async () => {
    const db = buildDb();
    db.shiftPassdown.create = async () => { throw new Error('db down'); };
    await assert.rejects(
      () => createPassdown(db, TENANT, { station: STATION, notes: 'x', instructions: [] }),
      /db down/,
    );
  });

  it('deriveShiftKind classifies 24h / 12h / otro windows', () => {
    assert.strictEqual(deriveShiftKind('2026-07-14T07:00:00Z', '2026-07-15T07:00:00Z'), '24h');
    assert.strictEqual(deriveShiftKind('2026-07-14T07:00:00Z', '2026-07-14T19:00:00Z'), '12h');
    assert.strictEqual(deriveShiftKind('2026-07-14T07:00:00Z', '2026-07-14T11:00:00Z'), 'otro');
    assert.strictEqual(deriveShiftKind(null, null), 'otro');
  });
});

describe('crud-g08 · shiftPassdownService.getIncomingForGuard (relevo receipt)', () => {
  const openPassdown = () => ({
    id: 'pd-1',
    tenantId: TENANT,
    channel: 'guard',
    stationId: 'st-1',
    status: 'open',
    outgoingGuardUserId: 'user-out',
    notes: 'Sin novedad',
    createdAt: new Date(),
    deletedAt: null,
  });

  it('marks the handover received with the incoming guard identity persisted', async () => {
    const db = buildDb({ shiftPassdowns: [openPassdown()] });
    const got = await getIncomingForGuard(db, TENANT, 'user-in', {
      stationIds: ['st-1'],
      markReceived: true,
      receivedByName: 'Ana Torres',
      receivedByShiftId: 'gs-9',
    });
    assert.ok(got, 'the open passdown at the station must be found');
    const row = db.shiftPassdown.rows[0];
    const applied = row.__updateCalls[0];
    assert.strictEqual(applied.status, 'received');
    assert.strictEqual(applied.receivedByGuardUserId, 'user-in');
    assert.strictEqual(applied.receivedByName, 'Ana Torres');
    assert.strictEqual(applied.receivedByShiftId, 'gs-9');
    assert.ok(applied.receivedAt instanceof Date, 'receivedAt must be stamped');
    assert.strictEqual(row.status, 'received');
  });

  it('never hands a guard their OWN passdown back (outgoing ≠ incoming)', async () => {
    const db = buildDb({ shiftPassdowns: [openPassdown()] });
    const got = await getIncomingForGuard(db, TENANT, 'user-out', {
      stationIds: ['st-1'],
      markReceived: true,
    });
    assert.strictEqual(got, null);
    assert.strictEqual(db.shiftPassdown.rows[0].status, 'open', 'row must stay open');
  });

  it('a guard clocking into a DIFFERENT station receives nothing', async () => {
    const db = buildDb({ shiftPassdowns: [openPassdown()] });
    const got = await getIncomingForGuard(db, TENANT, 'user-in', { stationIds: ['st-OTHER'] });
    assert.strictEqual(got, null);
  });
});

// ═══════════════════════════ visitorPreAuth ══════════════════════════════════

describe('crud-g08 · customerVisitorPreAuthCreate handler', () => {
  const seeds = () => ({
    businessInfos: [{ id: 'ps-1', tenantId: TENANT, clientAccountId: 'ca-1', deletedAt: null }],
    stations: [{ id: 'st-1', tenantId: TENANT, postSiteId: 'ps-1', stationName: 'Puesto Norte', deletedAt: null }],
  });
  const customerReq = (db: any, body: any) => fakeReq(db, {
    currentUser: { id: 'user-cust', clientAccountId: 'ca-1', tenantId: TENANT },
    body,
  });

  it('persists every pre-auth field (visitor identity, window, station chain, token, stamps)', async () => {
    const db = buildDb(seeds());
    const res = fakeRes();
    await customerVisitorPreAuthCreate(customerReq(db, {
      visitorFirstName: '  Eva ',
      visitorLastName: ' Luna ',
      visitorIdNumber: ' 1799999999 ',
      reason: ' Reunión ',
      company: ' ACME ',
      vehiclePlate: ' ABC-123 ',
      stationId: 'st-1',
      validFrom: '2026-07-14T08:00:00.000Z',
      validUntil: '2026-07-14T20:00:00.000Z',
    }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.qrToken, 'must return the QR token');
    assert.strictEqual(res.body.qrPayload, res.body.qrToken);

    const written = db.visitorPreAuthorization.calls.create[0];
    assert.strictEqual(written.clientAccountId, 'ca-1');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.postSiteId, 'ps-1', 'postSiteId must resolve from the station');
    assert.strictEqual(written.visitorFirstName, 'Eva');
    assert.strictEqual(written.visitorLastName, 'Luna');
    assert.strictEqual(written.visitorIdNumber, '1799999999');
    assert.strictEqual(written.reason, 'Reunión');
    assert.strictEqual(written.company, 'ACME');
    assert.strictEqual(written.vehiclePlate, 'ABC-123');
    assert.strictEqual(new Date(written.validFrom).toISOString(), '2026-07-14T08:00:00.000Z');
    assert.strictEqual(new Date(written.validUntil).toISOString(), '2026-07-14T20:00:00.000Z');
    assert.strictEqual(written.qrToken, res.body.qrToken);
    assert.strictEqual(written.status, 'active');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, 'user-cust');
    assert.strictEqual(written.updatedById, 'user-cust');
  });

  it('a db failure is NOT swallowed into a success response', async () => {
    const db = buildDb(seeds());
    db.visitorPreAuthorization.create = async () => { throw new Error('db down'); };
    const res = fakeRes();
    await customerVisitorPreAuthCreate(customerReq(db, { visitorFirstName: 'Eva' }), res);
    assert.strictEqual(res.statusCode, 500, 'db failure must surface as an error status');
    assert.notStrictEqual(res.body && res.body.success, true);
  });
});

describe('crud-g08 · visitorPreAuthScan handler', () => {
  const activePreAuth = (over: any = {}) => ({
    id: 'pa-1',
    tenantId: TENANT,
    qrToken: 'tok-1',
    status: 'active',
    clientAccountId: 'ca-1',
    stationId: 'st-1',
    postSiteId: null,
    visitorFirstName: 'Eva',
    visitorLastName: 'Luna',
    visitorIdNumber: '1799999999',
    reason: 'Reunión',
    company: 'ACME',
    vehiclePlate: 'ABC-123',
    validFrom: new Date(Date.now() - 3600e3),
    validUntil: new Date(Date.now() + 3600e3),
    deletedAt: null,
    ...over,
  });
  const seeds = (preAuthOver: any = {}) => ({
    visitorPreAuths: [activePreAuth(preAuthOver)],
    stations: [{ id: 'st-1', tenantId: TENANT, postSiteId: 'ps-1', stationName: 'Puesto Norte', deletedAt: null }],
  });

  it('materialises a full visitorLog from the pre-auth and marks it used', async () => {
    const db = buildDb(seeds());
    const res = fakeRes();
    await visitorPreAuthScan(fakeReq(db, { body: { qrToken: 'tok-1' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, true);

    // The visit row carries EVERY pre-auth field.
    const written = db.visitorLog.calls.create[0];
    assert.ok(written.visitDate instanceof Date);
    assert.strictEqual(written.firstName, 'Eva');
    assert.strictEqual(written.lastName, 'Luna');
    assert.strictEqual(written.idNumber, '1799999999');
    assert.strictEqual(written.reason, 'Reunión');
    assert.strictEqual(written.company, 'ACME');
    assert.strictEqual(written.vehiclePlate, 'ABC-123');
    assert.strictEqual(written.numPeople, 1);
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.stationName, 'Puesto Norte');
    assert.strictEqual(written.postSiteId, 'ps-1', 'postSiteId must complete from the station');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);

    // Pre-auth consumed: status/usedAt/guard/link all persisted via save().
    const pa = db.visitorPreAuthorization.rows[0];
    assert.strictEqual(pa.status, 'used');
    assert.ok(pa.usedAt instanceof Date);
    assert.strictEqual(pa.usedByGuardId, USER_ID);
    assert.strictEqual(pa.createdVisitorLogId, res.body.visitorLogId);
    assert.ok(pa.__saveCalls >= 1, 'save() must persist the consumed state');
  });

  it('an expired pre-auth is marked expired, persisted, and creates NO visit', async () => {
    const db = buildDb(seeds({ validUntil: new Date(Date.now() - 60e3) }));
    const res = fakeRes();
    await visitorPreAuthScan(fakeReq(db, { body: { qrToken: 'tok-1' } }), res);

    assert.strictEqual(res.body.valid, false);
    assert.strictEqual(res.body.reason, 'expired');
    const pa = db.visitorPreAuthorization.rows[0];
    assert.strictEqual(pa.status, 'expired');
    assert.ok(pa.__saveCalls >= 1, 'expiry flip must be persisted');
    assert.strictEqual(db.visitorLog.calls.create.length, 0);
  });

  it('an already-used pre-auth cannot create a second visit', async () => {
    const db = buildDb(seeds({ status: 'used', usedAt: new Date(), createdVisitorLogId: 'vl-old' }));
    const res = fakeRes();
    await visitorPreAuthScan(fakeReq(db, { body: { qrToken: 'tok-1' } }), res);
    assert.strictEqual(res.body.valid, false);
    assert.strictEqual(res.body.reason, 'already_used');
    assert.strictEqual(db.visitorLog.calls.create.length, 0);
  });

  it("a pre-auth from ANOTHER tenant's QR is not honored", async () => {
    const db = buildDb(seeds({ tenantId: OTHER_TENANT }));
    const res = fakeRes();
    await visitorPreAuthScan(fakeReq(db, { body: { qrToken: 'tok-1' } }), res);
    assert.strictEqual(res.body.valid, false);
    assert.strictEqual(res.body.reason, 'not_found');
    assert.strictEqual(db.visitorLog.calls.create.length, 0);
  });
});
