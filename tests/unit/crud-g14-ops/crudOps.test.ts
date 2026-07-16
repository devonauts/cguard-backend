/**
 * Unit tests — CRUD persistence fidelity for the g14-ops group:
 *   task · request · inquiries · feedback · report · performance
 *   (reports + operations are read-only aggregation endpoints — no writes).
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - TaskRepository create/update            (every writable field, station
 *                                              alias, file relations, where
 *                                              target, cross-tenant 404)
 *   - TaskService create                      (auto-approve defaults, commit,
 *                                              db-failure → rethrow + rollback)
 *   - TaskApprovalService decide              (approve/reject patch + scoping)
 *   - RequestRepository create/update/patch   (full fidelity, alias mapping,
 *                                              patch = only provided keys)
 *   - RequestService create                   (in-tenant FK filtering; documents
 *                                              the `guardName` filter bypass)
 *   - commentsService                         (documents request-comments going
 *                                              to the incidents table)
 *   - InquiriesRepository create/update
 *   - ReportRepository create/update + ReportService create
 *   - feedback POST handler                   (fidelity, clamp, 400, 500-not-200)
 *   - quizBankUpsert / quizQuestionUpsert     (create + update fidelity)
 *   - UniformInspectionService.create         (clamps + subject resolution)
 *   - BackupService confirmCover/reject       (state patch + tenant scoping)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g14-ops/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import TaskRepository from '../../../src/database/repositories/taskRepository';
import TaskService from '../../../src/services/taskService';
import TaskApprovalService from '../../../src/services/taskApprovalService';
import RequestRepository from '../../../src/database/repositories/requestRepository';
import RequestService from '../../../src/services/requestService';
import InquiriesRepository from '../../../src/database/repositories/inquiriesRepository';
import ReportRepository from '../../../src/database/repositories/reportRepository';
import ReportService from '../../../src/services/reportService';
import UniformInspectionService from '../../../src/services/uniformInspectionService';
import BackupService from '../../../src/services/backupService';
import PermissionChecker from '../../../src/services/user/permissionChecker';

import registerFeedbackRoutes from '../../../src/api/feedback';
import quizBankUpsert from '../../../src/api/performance/quizBankUpsert';
import quizQuestionUpsert from '../../../src/api/performance/quizQuestionUpsert';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
  const row: any = {
    deletedAt: null,
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
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    // Association getters used by the repos' _fillWithRelationsAndFiles.
    async getImageOptional() {
      return [];
    },
    async getTaskCompletedImage() {
      return [];
    },
    async getRequestDocumentPDF() {
      return [];
    },
    async getVoiceNote() {
      return [];
    },
  };
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
    if (typeof key === 'symbol') continue; // other operators unused here
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[key as string] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[key as string]))) return false;
          if (s === Op.notIn && Array.isArray(v) && v.includes(row[key as string])) return false;
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
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[] },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data });
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
      return model.rows.find((r: any) => r.id === id) || null;
    },
    async findAndCountAll(q: any = {}) {
      const rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return { rows, count: rows.length };
    },
    async count() {
      return 0;
    },
  };
  return model;
}

function makeSequelize() {
  const s: any = { commits: 0, rollbacks: 0 };
  s.transaction = async () => ({
    commit: async () => {
      s.commits++;
    },
    rollback: async () => {
      s.rollbacks++;
    },
  });
  return s;
}

function buildDb(seed: Record<string, any[]> = {}) {
  const db: any = {
    task: makeModel('task', seed.tasks || []),
    request: makeModel('request', seed.requests || []),
    incident: makeModel('incident', seed.incidents || []),
    inquiries: makeModel('inquiries', seed.inquiries || []),
    report: makeModel('report', seed.reports || []),
    appFeedback: makeModel('appFeedback', seed.appFeedbacks || []),
    quizBank: makeModel('quizBank', seed.quizBanks || []),
    quizQuestion: makeModel('quizQuestion', seed.quizQuestions || []),
    uniformInspection: makeModel('uniformInspection', seed.uniformInspections || []),
    backupEvent: makeModel('backupEvent', seed.backupEvents || []),
    station: makeModel('station', seed.stations || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    incidentType: makeModel('incidentType', seed.incidentTypes || []),
    service: makeModel('service', seed.services || []),
    tenantUser: makeModel('tenantUser', []),
    user: makeModel('user', []),
    file: makeModel('file', seed.files || []),
    auditLog: makeModel('auditLog', []),
    Sequelize, // FileRepository._removeLegacyFiles uses database.Sequelize.Op
    sequelize: makeSequelize(),
  };
  return db;
}

// Admin currentUser: passes the report repo's admin visibility check.
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
    headers: {},
    ...extra,
  } as any;
}

function fakeRes() {
  const res: any = { statusCode: null, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: any) => {
    res.body = b;
    return res;
  };
  res.send = (b: any) => {
    if (res.statusCode == null) res.statusCode = 200;
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

afterEach(() => sinon.restore());

// ═══════════════════════════════ TASK ════════════════════════════════════════

describe('g14-ops · TaskRepository', () => {
  const fullPayload = () => ({
    taskToDo: 'Revisar candados',
    description: 'Verificar los candados del portón trasero',
    assignedGuardId: 'sg-9',
    repeatConfig: '{"freq":"daily"}',
    completionNotes: 'quedó cerrado',
    wasItDone: true,
    dateToDoTheTask: '2026-07-15T08:00:00.000Z',
    dateCompletedTask: '2026-07-15T10:00:00.000Z',
    status: 'pending_approval',
    source: 'client',
    priority: 'alta',
    approvedById: 'user-9',
    approvedAt: '2026-07-14T00:00:00.000Z',
    approvalNotes: 'aprobado por cliente',
    clientAccountId: 'ca-1',
    completedByGuardId: 'sg-9',
    importHash: 'task-hash-1',
    taskBelongsToStation: 'st-1',
    imageOptional: [
      { new: true, id: 'f-img', name: 'antes.jpg', sizeInBytes: 10, privateUrl: 'p/antes.jpg', publicUrl: null },
    ],
    taskCompletedImage: [
      { new: true, id: 'f-done', name: 'despues.jpg', sizeInBytes: 12, privateUrl: 'p/despues.jpg', publicUrl: null },
    ],
  });

  it('create persists EVERY writable field the frontend can send (field fidelity)', async () => {
    const db = buildDb();
    const data = fullPayload();

    await TaskRepository.create(data, repoOptions(db));

    assert.strictEqual(db.task.calls.create.length, 1);
    const written = db.task.calls.create[0];
    for (const field of [
      'taskToDo', 'description', 'assignedGuardId', 'repeatConfig', 'completionNotes',
      'wasItDone', 'dateToDoTheTask', 'dateCompletedTask', 'status', 'source',
      'priority', 'approvedById', 'approvedAt', 'approvalNotes', 'clientAccountId',
      'completedByGuardId', 'importHash',
    ]) {
      assert.strictEqual(written[field], (data as any)[field], `field ${field} dropped or altered on create`);
    }
    // Alias mapping + stamps.
    assert.strictEqual(written.taskBelongsToStationId, 'st-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);

    // File relations persisted as file rows against the right column.
    const fileCols = db.file.calls.create.map((c: any) => c.belongsToColumn).sort();
    assert.deepStrictEqual(fileCols, ['imageOptional', 'taskCompletedImage']);
    const img = db.file.calls.create.find((c: any) => c.belongsToColumn === 'imageOptional');
    assert.strictEqual(img.name, 'antes.jpg');
    assert.strictEqual(img.tenantId, TENANT);
  });

  it('update targets the right row (id + tenantId in the where) and applies the full patch', async () => {
    const db = buildDb({
      tasks: [{ id: 't-1', tenantId: TENANT, taskToDo: 'viejo', wasItDone: false, priority: 'baja' }],
    });
    const data = { ...fullPayload(), taskToDo: 'nuevo texto', priority: 'media' };

    await TaskRepository.update('t-1', data, repoOptions(db));

    const where = db.task.calls.findOne[0].where;
    assert.strictEqual(where.id, 't-1');
    assert.strictEqual(where.tenantId, TENANT, 'update where-clause must be tenant-scoped');

    const row = db.task.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.taskToDo, 'nuevo texto');
    assert.strictEqual(patch.priority, 'media');
    assert.strictEqual(patch.wasItDone, true);
    assert.strictEqual(patch.completionNotes, 'quedó cerrado');
    assert.strictEqual(patch.taskBelongsToStationId, 'st-1');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(row.taskToDo, 'nuevo texto', 'patch not applied to the row');
  });

  it("update of another tenant's task throws 404 and writes NOTHING", async () => {
    const db = buildDb({
      tasks: [{ id: 't-foreign', tenantId: OTHER_TENANT, taskToDo: 'ajeno' }],
    });
    await assert.rejects(
      TaskRepository.update('t-foreign', { taskToDo: 'hackeado' }, repoOptions(db)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(db.task.rows[0].__updateCalls.length, 0);
    assert.strictEqual(db.task.rows[0].taskToDo, 'ajeno');
  });
});

describe('g14-ops · TaskService (CRM create wrapper)', () => {
  it('create auto-approves staff tasks (status/source/approvedById/approvedAt) and commits', async () => {
    const taskNotify = require('../../../src/services/taskNotify');
    if ((taskNotify as any).notifyTaskApproved?.restore) (taskNotify as any).notifyTaskApproved.restore();
    const notifyStub = sinon.stub(taskNotify, 'notifyTaskApproved').resolves();

    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT, stationName: 'Puesto 1' }] });
    const svc = new TaskService(repoOptions(db));

    await svc.create({
      taskToDo: 'Ronda extra',
      dateToDoTheTask: '2026-07-16T02:00:00.000Z',
      taskBelongsToStation: 'st-1',
    });

    const written = db.task.calls.create[0];
    assert.strictEqual(written.status, 'approved');
    assert.strictEqual(written.source, 'staff');
    assert.strictEqual(written.approvedById, USER_ID);
    assert.ok(written.approvedAt instanceof Date);
    assert.strictEqual(written.taskBelongsToStationId, 'st-1', 'in-tenant station must survive filterIdInTenant');
    assert.strictEqual(db.sequelize.commits, 1);
    assert.strictEqual(db.sequelize.rollbacks, 0);
    assert.strictEqual(notifyStub.callCount, 1, 'approved-on-create must notify the station guards');
  });

  it('create does NOT swallow a db failure: rethrows and rolls back', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT }] });
    db.task.create = async () => {
      throw new Error('DB write exploded');
    };
    const svc = new TaskService(repoOptions(db));

    await assert.rejects(
      svc.create({ taskToDo: 'x', dateToDoTheTask: '2026-07-16T02:00:00.000Z', taskBelongsToStation: 'st-1' }),
      /DB write exploded/,
    );
    assert.strictEqual(db.sequelize.rollbacks, 1);
    assert.strictEqual(db.sequelize.commits, 0);
  });
});

describe('g14-ops · TaskApprovalService.decide', () => {
  it('approve stamps status/approvedById/approvedAt/approvalNotes on the tenant-scoped row', async () => {
    const taskNotify = require('../../../src/services/taskNotify');
    if ((taskNotify as any).notifyTaskApproved?.restore) (taskNotify as any).notifyTaskApproved.restore();
    sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    if ((taskNotify as any).notifyTaskRejected?.restore) (taskNotify as any).notifyTaskRejected.restore();
    sinon.stub(taskNotify, 'notifyTaskRejected').resolves();

    const db = buildDb({
      tasks: [{ id: 't-1', tenantId: TENANT, status: 'pending_approval', approvalNotes: null }],
    });
    const svc = new TaskApprovalService(repoOptions(db));

    const out = await svc.decide('t-1', { status: 'approved', notes: 'todo bien' });

    const where = db.task.calls.findOne[0].where;
    assert.strictEqual(where.id, 't-1');
    assert.strictEqual(where.tenantId, TENANT);
    assert.strictEqual(where.deletedAt, null);

    const patch = db.task.rows[0].__updateCalls[0];
    assert.strictEqual(patch.status, 'approved');
    assert.strictEqual(patch.approvedById, USER_ID);
    assert.ok(patch.approvedAt instanceof Date);
    assert.strictEqual(patch.approvalNotes, 'todo bien');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(out.status, 'approved');
  });

  it('reject keeps the EXISTING approvalNotes when no notes are sent', async () => {
    const taskNotify = require('../../../src/services/taskNotify');
    if ((taskNotify as any).notifyTaskApproved?.restore) (taskNotify as any).notifyTaskApproved.restore();
    sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    if ((taskNotify as any).notifyTaskRejected?.restore) (taskNotify as any).notifyTaskRejected.restore();
    sinon.stub(taskNotify, 'notifyTaskRejected').resolves();

    const db = buildDb({
      tasks: [{ id: 't-1', tenantId: TENANT, status: 'pending_approval', approvalNotes: 'nota previa' }],
    });
    const svc = new TaskApprovalService(repoOptions(db));

    await svc.decide('t-1', { status: 'rejected' } as any);

    const patch = db.task.rows[0].__updateCalls[0];
    assert.strictEqual(patch.status, 'rejected');
    assert.strictEqual(patch.approvalNotes, 'nota previa', 'omitted notes must not wipe the previous value');
  });
});

// ══════════════════════════════ REQUEST ══════════════════════════════════════

describe('g14-ops · RequestRepository', () => {
  const fullPayload = () => ({
    incidentAt: '2026-07-14T22:00:00.000Z',
    dateTime: '2026-07-14T22:30:00.000Z',
    subject: 'Puerta abierta',
    content: 'Se encontró la puerta del galpón abierta',
    action: 'Recibido',
    actionsTaken: 'Se cerró y se notificó',
    priority: 'alta',
    callerType: 'cliente',
    callerName: 'María Paz',
    internalNotes: 'nota interna',
    location: 'Bodega 3',
    status: 'abierto',
    importHash: 'req-hash-1',
    guardId: 'sg-1',
    clientId: 'ca-1',
    siteId: 'bi-1',
    station: 'st-1',
    incidentTypeId: 'it-1',
    requestDocumentPDF: [
      { new: true, id: 'f-pdf', name: 'parte.pdf', sizeInBytes: 100, privateUrl: 'p/parte.pdf', publicUrl: null },
    ],
  });

  it('create persists every writable field + relation-id aliases', async () => {
    const db = buildDb();
    const data = fullPayload();

    await RequestRepository.create(data, repoOptions(db));

    const written = db.request.calls.create[0];
    for (const field of [
      'incidentAt', 'subject', 'content', 'action', 'actionsTaken', 'priority',
      'callerType', 'callerName', 'internalNotes', 'location', 'status', 'importHash',
    ]) {
      assert.strictEqual(written[field], (data as any)[field], `field ${field} dropped or altered on create`);
    }
    assert.strictEqual(written.dateTime, data.dateTime);
    assert.strictEqual(written.guardNameId, 'sg-1');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.siteId, 'bi-1');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.incidentTypeId, 'it-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);

    const pdf = db.file.calls.create.find((c: any) => c.belongsToColumn === 'requestDocumentPDF');
    assert.ok(pdf, 'requestDocumentPDF file row must be created');
    assert.strictEqual(pdf.name, 'parte.pdf');
  });

  it('create falls back dateTime → incidentAt when dateTime is omitted', async () => {
    const db = buildDb();
    await RequestRepository.create(
      { subject: 's', content: 'c', incidentAt: '2026-07-10T10:00:00.000Z' },
      repoOptions(db),
    );
    assert.strictEqual(db.request.calls.create[0].dateTime, '2026-07-10T10:00:00.000Z');
  });

  it('update targets id + tenantId and applies the full patch', async () => {
    const db = buildDb({
      requests: [{ id: 'r-1', tenantId: TENANT, subject: 'viejo', status: 'abierto', content: 'c' }],
    });
    const data = { ...fullPayload(), subject: 'nuevo asunto', status: 'cerrado' };

    await RequestRepository.update('r-1', data, repoOptions(db));

    const where = db.request.calls.findOne[0].where;
    assert.strictEqual(where.id, 'r-1');
    assert.strictEqual(where.tenantId, TENANT);

    const patch = db.request.rows[0].__updateCalls[0];
    assert.strictEqual(patch.subject, 'nuevo asunto');
    assert.strictEqual(patch.status, 'cerrado');
    assert.strictEqual(patch.internalNotes, 'nota interna');
    assert.strictEqual(patch.callerName, 'María Paz');
    assert.strictEqual(patch.stationId, 'st-1');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(db.request.rows[0].subject, 'nuevo asunto');
  });

  it("update of another tenant's request throws 404", async () => {
    const db = buildDb({ requests: [{ id: 'r-x', tenantId: OTHER_TENANT, subject: 'ajeno' }] });
    await assert.rejects(
      RequestRepository.update('r-x', { subject: 'no' }, repoOptions(db)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(db.request.rows[0].__updateCalls.length, 0);
  });

  it('patch only writes the provided keys — other fields and FKs stay untouched', async () => {
    const db = buildDb({
      requests: [{
        id: 'r-1', tenantId: TENANT, subject: 'orig', content: 'contenido original',
        clientId: 'ca-orig', guardNameId: 'sg-orig', status: 'abierto',
      }],
    });

    await RequestRepository.patch('r-1', { subject: 'parchado' }, repoOptions(db));

    const patch = db.request.rows[0].__updateCalls[0];
    assert.strictEqual(patch.subject, 'parchado');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.ok(!('content' in patch), 'patch must not touch unspecified content');
    assert.ok(!('clientId' in patch), 'patch must not touch unspecified clientId');
    assert.ok(!('guardNameId' in patch), 'patch must not touch unspecified guardNameId');
    assert.ok(!('dateTime' in patch), 'patch must not null-out dateTime when omitted');
    const row = db.request.rows[0];
    assert.strictEqual(row.content, 'contenido original');
    assert.strictEqual(row.clientId, 'ca-orig');
  });

  it("patch resolves the 'station' alias into stationId", async () => {
    const db = buildDb({ requests: [{ id: 'r-1', tenantId: TENANT, stationId: 'st-old' }] });
    await RequestRepository.patch('r-1', { station: 'st-new' }, repoOptions(db));
    assert.strictEqual(db.request.rows[0].__updateCalls[0].stationId, 'st-new');
  });
});

describe('g14-ops · RequestService (FK in-tenant filtering)', () => {
  const seedFks = () => ({
    securityGuards: [{ id: 'sg-1', tenantId: TENANT }, { id: 'sg-foreign', tenantId: OTHER_TENANT }],
    clientAccounts: [{ id: 'ca-1', tenantId: TENANT }],
    businessInfos: [{ id: 'bi-1', tenantId: TENANT }],
    stations: [{ id: 'st-1', tenantId: TENANT }],
    incidentTypes: [{ id: 'it-1', tenantId: TENANT }],
  });

  it('create keeps in-tenant FK ids and persists them', async () => {
    const db = buildDb(seedFks());
    const svc = new RequestService(repoOptions(db));

    await svc.create({
      subject: 's', content: 'c', status: 'abierto',
      guardId: 'sg-1', clientId: 'ca-1', siteId: 'bi-1', station: 'st-1', incidentTypeId: 'it-1',
    });

    const written = db.request.calls.create[0];
    assert.strictEqual(written.guardNameId, 'sg-1');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.siteId, 'bi-1');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.incidentTypeId, 'it-1');
    assert.strictEqual(db.sequelize.commits, 1);
  });

  it("create nulls a cross-tenant guardId (isolation filter)", async () => {
    const db = buildDb(seedFks());
    const svc = new RequestService(repoOptions(db));
    await svc.create({ subject: 's', content: 'c', guardId: 'sg-foreign' });
    assert.strictEqual(db.request.calls.create[0].guardNameId, null);
  });

  // FIXED: requestRepository now prefers the sanitized data.guardId (which
  // RequestService derives via filterIdInTenant from guardId || guardName)
  // over the raw legacy `guardName` alias, so a cross-tenant id sent through
  // the alias is nulled instead of persisted.
  it("create via the legacy 'guardName' key must not bypass the in-tenant filter", async () => {
    const db = buildDb(seedFks());
    const svc = new RequestService(repoOptions(db));
    await svc.create({ subject: 's', content: 'c', guardName: 'sg-foreign' });
    assert.strictEqual(db.request.calls.create[0].guardNameId, null);
  });

  it('create does NOT swallow a db failure: rethrows and rolls back', async () => {
    const db = buildDb(seedFks());
    db.request.create = async () => {
      throw new Error('insert failed');
    };
    const svc = new RequestService(repoOptions(db));
    await assert.rejects(svc.create({ subject: 's', content: 'c' }), /insert failed/);
    assert.strictEqual(db.sequelize.rollbacks, 1);
    assert.strictEqual(db.sequelize.commits, 0);
  });
});

describe('g14-ops · request comments (commentsService)', () => {
  // FIXED: commentsService now resolves the id against db.incident first
  // (Solicitudes is incident-backed) and FALLS BACK to db.request, so comments
  // on rows that live in the requests table land on request.comments instead
  // of 404ing and being lost. Both lookups stay tenant-scoped.
  it('createComment persists onto the REQUEST row the route names', async () => {
    const commentsModule = require('../../../src/services/comments');
    const modelsModule = require('../../../src/database/models');
    const db = buildDb({ requests: [{ id: 'r-1', tenantId: TENANT, comments: [] }] });
    if ((modelsModule as any).default?.restore) (modelsModule as any).default.restore();
    sinon.stub(modelsModule, 'default').returns(db);

    const created = await commentsModule.default.createComment(
      'r-1', TENANT, 'hola', { id: USER_ID, name: 'Admin' },
    );
    assert.ok(created && created.text === 'hola');
    assert.strictEqual((db.request.rows[0].comments || []).length, 1);
  });

  it('createComment appends to the incident row it actually targets (current behavior)', async () => {
    const commentsModule = require('../../../src/services/comments');
    const modelsModule = require('../../../src/database/models');
    const db = buildDb({ incidents: [{ id: 'i-1', tenantId: TENANT, comments: [] }] });
    if ((modelsModule as any).default?.restore) (modelsModule as any).default.restore();
    sinon.stub(modelsModule, 'default').returns(db);

    const created = await commentsModule.default.createComment(
      'i-1', TENANT, 'novedad revisada', { id: USER_ID, name: 'Admin' },
    );
    assert.strictEqual(created.text, 'novedad revisada');
    assert.strictEqual(created.author.id, USER_ID);
    const row = db.incident.rows[0];
    assert.strictEqual(row.comments.length, 1);
    assert.strictEqual(row.comments[0].text, 'novedad revisada');
    // and it is tenant-scoped: a foreign tenant id must 404
    await assert.rejects(
      commentsModule.default.createComment('i-1', OTHER_TENANT, 'x', { id: 'u2' }),
      /not found/i,
    );
  });
});

// ═════════════════════════════ INQUIRIES ═════════════════════════════════════

describe('g14-ops · InquiriesRepository', () => {
  const fullPayload = () => ({
    names: 'Juan Pérez',
    city: 'Quito',
    email: 'juan@test.ec',
    phoneNumber: '0999999999',
    message: 'Quiero información de guardias',
    importHash: 'inq-hash-1',
    serviceOfInterest: 'svc-1',
  });

  it('create persists every writable field + serviceOfInterest alias', async () => {
    const db = buildDb();
    const data = fullPayload();

    await InquiriesRepository.create(data, repoOptions(db));

    const written = db.inquiries.calls.create[0];
    for (const field of ['names', 'city', 'email', 'phoneNumber', 'message', 'importHash']) {
      assert.strictEqual(written[field], (data as any)[field], `field ${field} dropped on create`);
    }
    assert.strictEqual(written.serviceOfInterestId, 'svc-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('update targets id + tenantId and applies the patch', async () => {
    const db = buildDb({ inquiries: [{ id: 'q-1', tenantId: TENANT, names: 'viejo', city: 'Cuenca' }] });
    await InquiriesRepository.update('q-1', { ...fullPayload(), names: 'Nuevo Nombre' }, repoOptions(db));

    const where = db.inquiries.calls.findOne[0].where;
    assert.strictEqual(where.id, 'q-1');
    assert.strictEqual(where.tenantId, TENANT);
    const patch = db.inquiries.rows[0].__updateCalls[0];
    assert.strictEqual(patch.names, 'Nuevo Nombre');
    assert.strictEqual(patch.city, 'Quito');
    assert.strictEqual(patch.phoneNumber, '0999999999');
    assert.strictEqual(patch.serviceOfInterestId, 'svc-1');
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  it("update of another tenant's inquiry throws 404", async () => {
    const db = buildDb({ inquiries: [{ id: 'q-x', tenantId: OTHER_TENANT }] });
    await assert.rejects(
      InquiriesRepository.update('q-x', { names: 'n' }, repoOptions(db)),
      (e: any) => e.code === 404,
    );
  });
});

// ═══════════════════════════════ REPORT ══════════════════════════════════════

describe('g14-ops · ReportRepository / ReportService', () => {
  const fullPayload = () => ({
    title: 'Informe nocturno',
    generatedDate: '2026-07-14T06:00:00.000Z',
    content: 'Sin novedad en el turno',
    importHash: 'rep-hash-1',
    station: 'st-1',
  });

  it('create persists title/generatedDate/content/importHash + station alias', async () => {
    const db = buildDb();
    const data = fullPayload();

    await ReportRepository.create(data, repoOptions(db));

    const written = db.report.calls.create[0];
    assert.strictEqual(written.title, data.title);
    assert.strictEqual(written.generatedDate, data.generatedDate);
    assert.strictEqual(written.content, data.content);
    assert.strictEqual(written.importHash, data.importHash);
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('update targets id + tenantId and applies the patch', async () => {
    const db = buildDb({ reports: [{ id: 'rep-1', tenantId: TENANT, title: 'viejo', stationId: null }] });
    await ReportRepository.update('rep-1', { ...fullPayload(), title: 'Informe corregido' }, repoOptions(db));

    const where = db.report.calls.findOne[0].where;
    assert.strictEqual(where.id, 'rep-1');
    assert.strictEqual(where.tenantId, TENANT);
    const patch = db.report.rows[0].__updateCalls[0];
    assert.strictEqual(patch.title, 'Informe corregido');
    assert.strictEqual(patch.content, 'Sin novedad en el turno');
    assert.strictEqual(patch.stationId, 'st-1');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(db.report.rows[0].title, 'Informe corregido');
  });

  it("update of another tenant's report throws 404", async () => {
    const db = buildDb({ reports: [{ id: 'rep-x', tenantId: OTHER_TENANT, title: 'ajeno' }] });
    await assert.rejects(
      ReportRepository.update('rep-x', { title: 'no' }, repoOptions(db)),
      (e: any) => e.code === 404,
    );
  });

  it('ReportService.create filters the station in-tenant, commits, and rethrows db failures', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT }] });
    const svc = new ReportService(repoOptions(db));
    await svc.create(fullPayload());
    assert.strictEqual(db.report.calls.create[0].stationId, 'st-1');
    assert.strictEqual(db.sequelize.commits, 1);

    const db2 = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT }] });
    db2.report.create = async () => {
      throw new Error('report insert failed');
    };
    const svc2 = new ReportService(repoOptions(db2));
    await assert.rejects(svc2.create(fullPayload()), /report insert failed/);
    assert.strictEqual(db2.sequelize.rollbacks, 1);
  });
});

// ══════════════════════════════ FEEDBACK ═════════════════════════════════════

describe('g14-ops · feedback POST handler', () => {
  function getHandler() {
    const handlers: Record<string, any> = {};
    registerFeedbackRoutes({ post: (p: string, h: any) => (handlers[p] = h) } as any);
    const h = handlers['/tenant/:tenantId/feedback'];
    assert.ok(h, 'feedback route must register');
    return h;
  }

  it('persists tenantId/userId/rating/comment/source/audit stamps', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { data: { rating: 4, comment: 'muy buena app' } } });
    const res = fakeRes();

    await getHandler()(req, res);

    assert.strictEqual(res.statusCode, 200);
    const written = db.appFeedback.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.userId, USER_ID);
    assert.strictEqual(written.rating, 4);
    assert.strictEqual(written.comment, 'muy buena app');
    assert.strictEqual(written.source, 'crm');
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('clamps an out-of-range rating into 1..5', async () => {
    const db = buildDb();
    const res = fakeRes();
    await getHandler()(fakeReq(db, { body: { data: { rating: 99 } } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.appFeedback.calls.create[0].rating, 5);
  });

  // FIXED: the handler now validates parseInt(rating) BEFORE clamping, so a
  // missing/garbage rating returns 400 instead of persisting a phantom 1-star.
  it('missing rating → 400 and NO row written', async () => {
    const db = buildDb();
    const res = fakeRes();
    await getHandler()(fakeReq(db, { body: { data: { comment: 'sin estrellas' } } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.appFeedback.calls.create.length, 0);
  });

  it('a db failure is NOT swallowed into a success response', async () => {
    const db = buildDb();
    db.appFeedback.create = async () => {
      throw new Error('disk full');
    };
    const res = fakeRes();
    await getHandler()(fakeReq(db, { body: { data: { rating: 3 } } }), res);
    assert.strictEqual(res.statusCode, 500, 'db failure must surface as 500, not 200');
  });
});

// ═════════════════════════════ PERFORMANCE ═══════════════════════════════════

describe('g14-ops · performance quiz handlers', () => {
  beforeEach(() => {
    if ((PermissionChecker.prototype as any).validateHas?.restore) (PermissionChecker.prototype as any).validateHas.restore();
    sinon.stub(PermissionChecker.prototype, 'validateHas').returns(undefined as any);
  });

  it('quizBankUpsert CREATE persists title/questionsPerAttempt/passPct/active + scope', async () => {
    const db = buildDb();
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1' },
      body: { data: { title: 'Banco puesto 1', questionsPerAttempt: 5, passPct: 80, active: false } },
    });
    const res = fakeRes();

    await quizBankUpsert(req, res);

    assert.strictEqual(res.statusCode, 200);
    const written = db.quizBank.calls.create[0];
    assert.strictEqual(written.title, 'Banco puesto 1');
    assert.strictEqual(written.questionsPerAttempt, 5);
    assert.strictEqual(written.passPct, 80);
    assert.strictEqual(written.active, false);
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('quizBankUpsert UPDATE patches only the provided fields on the tenant-scoped bank', async () => {
    const db = buildDb({
      quizBanks: [{ id: 'qb-1', tenantId: TENANT, stationId: 'st-1', title: 'viejo', questionsPerAttempt: 10, passPct: 70, active: true }],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, stationId: 'st-1' },
      body: { data: { title: 'Banco actualizado', passPct: 90 } },
    });
    const res = fakeRes();

    await quizBankUpsert(req, res);

    assert.strictEqual(res.statusCode, 200);
    const where = db.quizBank.calls.findOne[0].where;
    assert.strictEqual(where.tenantId, TENANT);
    assert.strictEqual(where.stationId, 'st-1');
    const patch = db.quizBank.rows[0].__updateCalls[0];
    assert.strictEqual(patch.title, 'Banco actualizado');
    assert.strictEqual(patch.passPct, 90);
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.ok(!('questionsPerAttempt' in patch), 'unspecified field must not be rewritten');
    assert.strictEqual(db.quizBank.rows[0].questionsPerAttempt, 10);
  });

  it('quizQuestionUpsert CREATE persists prompt/options/correctIndex/weight/active', async () => {
    const db = buildDb({ quizBanks: [{ id: 'qb-1', tenantId: TENANT, stationId: 'st-1' }] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, bankId: 'qb-1' },
      body: { data: { prompt: '¿Qué hacer ante un robo?', options: ['a', 'b', 'c'], correctIndex: 2, weight: 3, active: true } },
    });
    const res = fakeRes();

    await quizQuestionUpsert(req, res);

    assert.strictEqual(res.statusCode, 200);
    const written = db.quizQuestion.calls.create[0];
    assert.strictEqual(written.prompt, '¿Qué hacer ante un robo?');
    assert.deepStrictEqual(written.options, ['a', 'b', 'c']);
    assert.strictEqual(written.correctIndex, 2);
    assert.strictEqual(written.weight, 3);
    assert.strictEqual(written.active, true);
    assert.strictEqual(written.quizBankId, 'qb-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('quizQuestionUpsert UPDATE keeps unspecified fields and targets bank+tenant', async () => {
    const db = buildDb({
      quizBanks: [{ id: 'qb-1', tenantId: TENANT }],
      quizQuestions: [{ id: 'qq-1', quizBankId: 'qb-1', tenantId: TENANT, prompt: 'viejo?', options: ['x', 'y'], correctIndex: 0, weight: 1, active: true }],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, bankId: 'qb-1', questionId: 'qq-1' },
      body: { data: { prompt: '¿nuevo?' } },
    });
    const res = fakeRes();

    await quizQuestionUpsert(req, res);

    assert.strictEqual(res.statusCode, 200);
    const where = db.quizQuestion.calls.findOne[0].where;
    assert.strictEqual(where.id, 'qq-1');
    assert.strictEqual(where.quizBankId, 'qb-1');
    assert.strictEqual(where.tenantId, TENANT);
    const patch = db.quizQuestion.rows[0].__updateCalls[0];
    assert.strictEqual(patch.prompt, '¿nuevo?');
    assert.deepStrictEqual(patch.options, ['x', 'y'], 'omitted options must keep the stored value');
    assert.strictEqual(patch.correctIndex, 0);
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  it('quizQuestionUpsert rejects an invalid question (no prompt) with 400, nothing written', async () => {
    const db = buildDb({ quizBanks: [{ id: 'qb-1', tenantId: TENANT }] });
    const res = fakeRes();
    await quizQuestionUpsert(
      fakeReq(db, { params: { tenantId: TENANT, bankId: 'qb-1' }, body: { data: { options: ['a', 'b'] } } }),
      res,
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.quizQuestion.calls.create.length, 0);
  });
});

describe('g14-ops · UniformInspectionService.create', () => {
  it('persists every field, clamps rating/stars, resolves guard subject', async () => {
    const db = buildDb({ securityGuards: [{ id: 'sg-1', guardId: 'u-guard', tenantId: TENANT }] });

    const out = await UniformInspectionService.create(db, {
      tenantId: TENANT,
      subjectUserId: 'u-guard',
      inspectorId: USER_ID,
      rating: 150, // out of range → clamp 100
      stars: 7, // out of range → clamp 5
      notes: 'uniforme completo',
      photos: ['p1.jpg', 'p2.jpg'],
      stationId: 'st-1',
      inspectionDate: '2026-07-10T12:00:00.000Z',
    });

    const written = db.uniformInspection.calls.create[0];
    assert.strictEqual(written.subjectType, 'guard');
    assert.strictEqual(written.securityGuardId, 'sg-1');
    assert.strictEqual(written.subjectUserId, 'u-guard');
    assert.strictEqual(written.inspectorId, USER_ID);
    assert.strictEqual(written.rating, 100);
    assert.strictEqual(written.stars, 5);
    assert.strictEqual(written.notes, 'uniforme completo');
    assert.deepStrictEqual(written.photos, ['p1.jpg', 'p2.jpg']);
    assert.strictEqual(written.stationId, 'st-1');
    assert.ok(written.inspectionDate instanceof Date);
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(out.rating, 100);
  });

  it('falls back to subjectType=supervisor when no securityGuard row exists', async () => {
    const db = buildDb();
    await UniformInspectionService.create(db, {
      tenantId: TENANT, subjectUserId: 'u-sup', inspectorId: USER_ID, rating: 90,
    });
    const written = db.uniformInspection.calls.create[0];
    assert.strictEqual(written.subjectType, 'supervisor');
    assert.strictEqual(written.securityGuardId, null);
    assert.strictEqual(written.rating, 90);
  });
});

describe('g14-ops · BackupService confirm/reject', () => {
  it('confirmCover patches kind/status/points/confirmedById on the tenant-scoped event', async () => {
    const db = buildDb({ backupEvents: [{ id: 'be-1', tenantId: TENANT, status: 'pending', points: 0 }] });

    const out = await BackupService.confirmCover(db, {
      tenantId: TENANT, eventId: 'be-1', confirmedById: USER_ID,
    });

    const where = db.backupEvent.calls.findOne[0].where;
    assert.strictEqual(where.id, 'be-1');
    assert.strictEqual(where.tenantId, TENANT);
    const patch = db.backupEvent.rows[0].__updateCalls[0];
    assert.strictEqual(patch.kind, 'cover');
    assert.strictEqual(patch.status, 'confirmed');
    assert.ok(typeof patch.points === 'number' && patch.points > 0, 'confirm must award points');
    assert.strictEqual(patch.confirmedById, USER_ID);
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(out.status, 'confirmed');
  });

  it('reject zeroes the points; a cross-tenant event resolves to null (no write)', async () => {
    const db = buildDb({ backupEvents: [{ id: 'be-1', tenantId: TENANT, status: 'pending', points: 4 }] });
    await BackupService.reject(db, { tenantId: TENANT, eventId: 'be-1', confirmedById: USER_ID });
    const patch = db.backupEvent.rows[0].__updateCalls[0];
    assert.strictEqual(patch.status, 'rejected');
    assert.strictEqual(patch.points, 0);

    const db2 = buildDb({ backupEvents: [{ id: 'be-2', tenantId: OTHER_TENANT, status: 'pending' }] });
    const out = await BackupService.confirmCover(db2, {
      tenantId: TENANT, eventId: 'be-2', confirmedById: USER_ID,
    });
    assert.strictEqual(out, null);
    assert.strictEqual(db2.backupEvent.rows[0].__updateCalls.length, 0);
  });
});
