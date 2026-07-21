/**
 * Unit tests — Visitantes, tareas y solicitudes (domain: op-visitantes-tareas).
 *
 * The g08/g14/g15 suites already cover the basic create/update/patch/404
 * field-fidelity for visitorLog, request, task and service. This suite fills the
 * GAPS the daily operation of a security company actually hits and that no other
 * suite exercises:
 *
 *   A. TaskRepository partial-update (null-clobber)  — a worker completing a task
 *      sends {wasItDone,status,...} WITHOUT the station; unlike the incident/kpi/
 *      request repos (which presence-guard their FKs) the task repo writes
 *      `taskBelongsToStationId: data.taskBelongsToStation || null` UNCONDITIONALLY,
 *      detaching the task from its post/station. Pinned as a BUG (XFAIL).
 *
 *   B. Task 4-app FLOW (TaskService)                 — cliente crea (source=client,
 *      status=pending_approval → NO auto-stamp) vs staff crea (auto-approved +
 *      approvedById/approvedAt stamped + notify fired). Then CRM decide
 *      (approve/reject transitions + approver stamp + rejection-notes) via
 *      TaskApprovalService.
 *
 *   C. RequestRepository.update dateTime null-clobber — the `update` path writes
 *      `dateTime: data.dateTime || data.incidentAt || null`, so a partial update
 *      that omits both wipes the stored dateTime (the patch() path is safe).
 *      FK links, by contrast, ARE presence-guarded (verified green).
 *
 *   D. ServiceRepository duplicate guard             — create/update reject a
 *      duplicate title/description within the tenant with Error400; the update
 *      dup check must EXCLUDE the row itself.
 *
 *   E. RequestShareRepository + publicRequest handler — the public, no-auth
 *      "solicitud compartida por token" flow: missing token → 400, unknown/
 *      expired token → 404, valid token → the tenant-scoped request payload.
 *
 *   F. feedback handler (app rating)                 — rating validation (missing/
 *      garbage → 400, NOT a phantom 1-star row), clamp to 1..5, comment cap,
 *      tenant/user stamping, comment never required.
 *
 * All against a Sequelize-shaped in-memory fake db (NO MySQL, NO network); only
 * the audit-log / file / push side channels are stubbed. Real production
 * repositories/services/handlers run end-to-end.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-visitantes-tareas/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import TaskRepository from '../../../src/database/repositories/taskRepository';
import RequestRepository from '../../../src/database/repositories/requestRepository';
import ServiceRepository from '../../../src/database/repositories/serviceRepository';
import RequestShareRepository from '../../../src/database/repositories/requestShareRepository';
import TaskService from '../../../src/services/taskService';
import TaskApprovalService from '../../../src/services/taskApprovalService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';
import * as taskNotify from '../../../src/services/taskNotify';

import publicRequest from '../../../src/api/publicRequest';
import feedbackModule from '../../../src/api/feedback';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
  const base: any = {
    ...data,
    __updateCalls: [] as any[],
    __destroyed: false,
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(base)) {
        if (k.startsWith('__') || typeof base[k] === 'function') continue;
        plain[k] = base[k];
      }
      return opts && opts.plain ? { ...plain } : plain;
    },
    async update(patch: any) {
      base.__updateCalls.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) base[k] = v;
      }
      return base;
    },
    async reload() {
      return base;
    },
    async destroy() {
      base.__destroyed = true;
      return base;
    },
  };
  // Any Sequelize association getter (getIconImage, getRequestDocumentPDF, …)
  // resolves to null so the *_fillWithRelationsAndFiles enrichers don't blow up.
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^get[A-Z]/.test(prop)) {
        return async () => null;
      }
      return target[prop as any];
    },
  });
}

/** Where matcher: plain equality + Op.and/or/ne/in/gt/gte/lt/lte. Defensive. */
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
      if (!parts.some((p) => { try { return matchWhere(row, p); } catch { return false; } })) return false;
      continue;
    }
    if (typeof key === 'symbol') continue; // unknown operator — ignore
    // A plain array value means Sequelize IN (…): e.g. where.status = ['pending_approval'].
    if (Array.isArray(cond)) {
      if (!cond.includes(row[key as string])) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          const cur = row[key as string];
          if (s === Op.ne && cur === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(cur))) return false;
          if (s === Op.gt && !(cur > v)) return false;
          if (s === Op.gte && !(cur >= v)) return false;
          if (s === Op.lt && !(cur < v)) return false;
          if (s === Op.lte && !(cur <= v)) return false;
        }
        continue;
      }
      // A nested plain object we don't understand → treat as non-matching.
      return false;
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
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      let rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (q.offset) rows = rows.slice(Number(q.offset));
      if (q.limit) rows = rows.slice(0, Number(q.limit));
      return rows;
    },
    async findAndCountAll(q: any = {}) {
      model.calls.findAll.push(q);
      const all = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      let rows = all;
      if (q.offset) rows = rows.slice(Number(q.offset));
      if (q.limit) rows = rows.slice(0, Number(q.limit));
      return { rows, count: all.length };
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

function buildDb(seed: {
  tasks?: any[];
  requests?: any[];
  services?: any[];
  requestShares?: any[];
  appFeedbacks?: any[];
  stations?: any[];
  clientAccounts?: any[];
  businessInfos?: any[];
  securityGuards?: any[];
  incidentTypes?: any[];
  taxes?: any[];
} = {}) {
  return {
    task: makeModel('task', seed.tasks || []),
    request: makeModel('request', seed.requests || []),
    service: makeModel('service', seed.services || []),
    requestShare: makeModel('requestShare', seed.requestShares || []),
    appFeedback: makeModel('appFeedback', seed.appFeedbacks || []),
    station: makeModel('station', seed.stations || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    incidentType: makeModel('incidentType', seed.incidentTypes || []),
    tax: makeModel('tax', seed.taxes || []),
    file: makeModel('file', []),
    sequelize: {
      transaction: async () => ({ commit: async () => {}, rollback: async () => {} }),
      query: async () => [[{ count: 0 }]],
    },
  } as any;
}

function currentUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: currentUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

function stubSideChannels() {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
}

// ═══════════════════════ A · TaskRepository partial-update wipe ═══════════════
describe('op-visitantes-tareas · TaskRepository partial update (station link)', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  const seedTask = () => ({
    tasks: [
      {
        id: 't-1',
        tenantId: TENANT,
        taskToDo: 'Revisar portón',
        status: 'approved',
        source: 'client',
        wasItDone: false,
        assignedGuardId: 'sg-1',
        clientAccountId: 'ca-1',
        taskBelongsToStationId: 'st-1',
        deletedAt: null,
      },
    ],
  });

  it('a partial update that DOES re-send the station keeps the link (baseline works)', async () => {
    const db = buildDb(seedTask());
    await TaskRepository.update(
      't-1',
      { wasItDone: true, status: 'approved', taskBelongsToStation: 'st-1' },
      repoOptions(db),
    );
    const row = db.task.rows[0];
    assert.strictEqual(row.wasItDone, true);
    assert.strictEqual(row.taskBelongsToStationId, 'st-1');
  });

  it('lodash-picked FKs (assignedGuardId/clientAccountId) survive a partial update', async () => {
    const db = buildDb(seedTask());
    await TaskRepository.update('t-1', { status: 'approved', wasItDone: true }, repoOptions(db));
    const row = db.task.rows[0];
    // These go through lodash.pick, so an omitted key stays undefined and the
    // presence guard keeps the stored value — the correct behaviour.
    assert.strictEqual(row.assignedGuardId, 'sg-1', 'assignedGuardId wiped by partial update');
    assert.strictEqual(row.clientAccountId, 'ca-1', 'clientAccountId wiped by partial update');
  });

  // XFAIL — DOCUMENTS A REAL BUG. A worker completing a task sends
  // {wasItDone,status,completionNotes,...} but NOT taskBelongsToStation.
  // TaskRepository.update writes `taskBelongsToStationId: data.taskBelongsToStation || null`
  // UNCONDITIONALLY (unlike the incident/request repos which presence-guard the
  // station FK), so the completed task is detached from its post/station and
  // vanishes from the post-site Overview counts. The assert below reflects the
  // CORRECT expectation (link preserved) and therefore FAILS on current code.
  it('XFAIL(bug): a partial update WITHOUT the station must NOT wipe taskBelongsToStationId', async () => {
    const db = buildDb(seedTask());
    await TaskRepository.update(
      't-1',
      { wasItDone: true, status: 'approved', completionNotes: 'hecho' },
      repoOptions(db),
    );
    const row = db.task.rows[0];
    assert.strictEqual(
      row.taskBelongsToStationId,
      'st-1',
      'BUG: taskBelongsToStationId nulled by a partial update (station-FK not presence-guarded)',
    );
  });

  it('FIXED: a partial update no longer writes taskBelongsToStationId at all (presence-guarded)', async () => {
    const db = buildDb(seedTask());
    await TaskRepository.update('t-1', { wasItDone: true }, repoOptions(db));
    const patch = db.task.rows[0].__updateCalls[0];
    // The station link is now presence-guarded → undefined (Sequelize ignores it)
    // instead of a null write, so a partial update never detaches the puesto.
    assert.strictEqual(
      patch.taskBelongsToStationId,
      undefined,
      'station link must not be touched by an update that omits it',
    );
  });
});

// ═══════════════════════ B · Task 4-app flow (TaskService) ════════════════════
describe('op-visitantes-tareas · TaskService create (cliente vs staff)', () => {
  beforeEach(() => {
    stubSideChannels();
    if ((taskNotify as any).notifyTaskApproved?.restore) (taskNotify as any).notifyTaskApproved.restore();
    sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
  });
  afterEach(() => sinon.restore());

  it('STAFF-created task auto-approves, stamps approver, and fires the approved notify', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT, stationName: 'Puesto 1', deletedAt: null }] });
    const service = new TaskService(repoOptions(db));
    const created = await service.create({
      taskToDo: 'Ronda extra',
      taskBelongsToStation: 'st-1',
      // no status / no source → staff auto-approve path
    });
    const written = db.task.calls.create[0];
    assert.strictEqual(written.status, 'approved', 'staff task must be auto-approved');
    assert.strictEqual(written.source, 'staff', 'staff source not defaulted');
    assert.strictEqual(written.approvedById, USER_ID, 'approver not stamped on auto-approval');
    assert.ok(written.approvedAt instanceof Date, 'approvedAt not stamped on auto-approval');
    assert.strictEqual(written.taskBelongsToStationId, 'st-1');
    assert.strictEqual((created as any).status, 'approved');
    const notify = taskNotify.notifyTaskApproved as sinon.SinonStub;
    assert.strictEqual(notify.callCount, 1, 'approved notify must fire on staff creation');
  });

  it('CLIENT-created task (source=client, pending_approval) stays PENDING — no approver, no notify', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT, stationName: 'Puesto 1', deletedAt: null }] });
    const service = new TaskService(repoOptions(db));
    await service.create({
      taskToDo: 'Cambiar foco',
      source: 'client',
      status: 'pending_approval',
      clientAccountId: 'ca-1',
      taskBelongsToStation: 'st-1',
    });
    const written = db.task.calls.create[0];
    assert.strictEqual(written.status, 'pending_approval', 'client task must NOT be auto-approved');
    assert.strictEqual(written.source, 'client');
    assert.strictEqual(written.approvedById, undefined, 'client task must not be pre-stamped with an approver');
    assert.strictEqual(written.approvedAt, undefined, 'client task must not carry an approvedAt yet');
    const notify = taskNotify.notifyTaskApproved as sinon.SinonStub;
    assert.strictEqual(notify.callCount, 0, 'approved notify must NOT fire for a pending client task');
  });

  it("create filters a foreign-tenant station id to null (cross-tenant station rejected)", async () => {
    const db = buildDb({ stations: [{ id: 'st-x', tenantId: OTHER_TENANT, stationName: 'Ajeno', deletedAt: null }] });
    const service = new TaskService(repoOptions(db));
    await service.create({ taskToDo: 'X', taskBelongsToStation: 'st-x', source: 'client', status: 'pending_approval' });
    const written = db.task.calls.create[0];
    assert.strictEqual(written.taskBelongsToStationId, null, "another tenant's station must not persist");
  });
});

describe('op-visitantes-tareas · TaskApprovalService decide (CRM approve/reject)', () => {
  beforeEach(() => {
    stubSideChannels();
    if ((taskNotify as any).notifyTaskApproved?.restore) (taskNotify as any).notifyTaskApproved.restore();
    if ((taskNotify as any).notifyTaskRejected?.restore) (taskNotify as any).notifyTaskRejected.restore();
    sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    sinon.stub(taskNotify, 'notifyTaskRejected').resolves();
  });
  afterEach(() => sinon.restore());

  const seedPending = () => ({
    tasks: [
      {
        id: 't-1',
        tenantId: TENANT,
        taskToDo: 'Cambiar foco',
        status: 'pending_approval',
        source: 'client',
        approvalNotes: null,
        deletedAt: null,
      },
    ],
  });

  it('REJECT flips status→rejected, stamps approver, persists rejection notes, fires rejected notify', async () => {
    const db = buildDb(seedPending());
    const svc = new TaskApprovalService(repoOptions(db));
    const plain = await svc.decide('t-1', { status: 'rejected', notes: 'no aplica' });
    const row = db.task.rows[0];
    assert.strictEqual(row.status, 'rejected');
    assert.strictEqual(row.approvedById, USER_ID, 'decider not recorded on rejection');
    assert.ok(row.approvedAt instanceof Date, 'decision timestamp not recorded');
    assert.strictEqual(row.approvalNotes, 'no aplica', 'rejection notes not persisted');
    assert.strictEqual((plain as any).status, 'rejected');
    assert.strictEqual((taskNotify.notifyTaskRejected as sinon.SinonStub).callCount, 1);
    assert.strictEqual((taskNotify.notifyTaskApproved as sinon.SinonStub).callCount, 0);
  });

  it('reject WITHOUT notes keeps the previous approvalNotes (no null-clobber)', async () => {
    const db = buildDb({
      tasks: [{ id: 't-1', tenantId: TENANT, status: 'pending_approval', approvalNotes: 'nota previa', deletedAt: null }],
    });
    const svc = new TaskApprovalService(repoOptions(db));
    await svc.decide('t-1', { status: 'rejected' });
    assert.strictEqual(db.task.rows[0].approvalNotes, 'nota previa', 'omitted notes wiped the prior value');
  });

  it('decide on a foreign-tenant task throws 404 and changes nothing', async () => {
    const db = buildDb({
      tasks: [{ id: 't-1', tenantId: OTHER_TENANT, status: 'pending_approval', deletedAt: null }],
    });
    const svc = new TaskApprovalService(repoOptions(db));
    await assert.rejects(() => svc.decide('t-1', { status: 'approved' }), (e: any) => e instanceof Error404);
    assert.strictEqual(db.task.rows[0].__updateCalls.length, 0);
  });

  it('listByStatus default queue is tenant-scoped to pending_approval only', async () => {
    const db = buildDb({
      tasks: [
        { id: 't-1', tenantId: TENANT, status: 'pending_approval', deletedAt: null },
        { id: 't-2', tenantId: TENANT, status: 'approved', deletedAt: null },
        { id: 't-3', tenantId: OTHER_TENANT, status: 'pending_approval', deletedAt: null },
      ],
    });
    const svc = new TaskApprovalService(repoOptions(db));
    const { rows } = await svc.listByStatus({});
    assert.strictEqual(rows.length, 1, 'queue must show only this-tenant pending tasks');
    assert.strictEqual(rows[0].id, 't-1');
  });
});

// ═══════════════════════ C · RequestRepository.update dateTime clobber ════════
describe('op-visitantes-tareas · RequestRepository.update (dateTime vs FK guarding)', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  const seedRequest = () => ({
    requests: [
      {
        id: 'r-1',
        tenantId: TENANT,
        subject: 'Reporte',
        content: 'contenido',
        status: 'abierto',
        dateTime: '2026-07-01T08:00:00.000Z',
        guardNameId: 'sg-1',
        clientId: 'ca-1',
        siteId: 'si-1',
        stationId: 'st-1',
        incidentTypeId: 'it-1',
        deletedAt: null,
      },
    ],
  });

  it('FK links ARE presence-guarded — a status-only update keeps client/site/station/guard/type', async () => {
    const db = buildDb(seedRequest());
    await RequestRepository.update('r-1', { status: 'cerrado' }, repoOptions(db));
    const row = db.request.rows[0];
    assert.strictEqual(row.status, 'cerrado');
    assert.strictEqual(row.guardNameId, 'sg-1', 'guardNameId wiped by partial update');
    assert.strictEqual(row.clientId, 'ca-1', 'clientId wiped by partial update');
    assert.strictEqual(row.siteId, 'si-1', 'siteId wiped by partial update');
    assert.strictEqual(row.stationId, 'st-1', 'stationId wiped by partial update');
    assert.strictEqual(row.incidentTypeId, 'it-1', 'incidentTypeId wiped by partial update');
  });

  // XFAIL — DOCUMENTS A REAL BUG. Unlike the FKs above, `dateTime` is written
  // as `data.dateTime || data.incidentAt || null` with NO presence guard, so a
  // partial update that omits both fields nulls the stored occurrence time.
  // (The patch() path is guarded — see g14 — but update() is not.) The assert
  // reflects the CORRECT expectation and FAILS on current code.
  it('XFAIL(bug): a status-only update must NOT null the stored dateTime', async () => {
    const db = buildDb(seedRequest());
    await RequestRepository.update('r-1', { status: 'cerrado' }, repoOptions(db));
    const row = db.request.rows[0];
    assert.strictEqual(
      row.dateTime,
      '2026-07-01T08:00:00.000Z',
      'BUG: dateTime nulled by a partial update (not presence-guarded like the FKs)',
    );
  });

  it('FIXED: a status-only update no longer writes dateTime (presence-guarded like the FKs)', async () => {
    const db = buildDb(seedRequest());
    await RequestRepository.update('r-1', { status: 'cerrado' }, repoOptions(db));
    const patch = db.request.rows[0].__updateCalls[0];
    assert.strictEqual(patch.dateTime, undefined, 'dateTime untouched when omitted → stored value survives');
  });

  it('a full update that re-sends dateTime + FKs persists them all', async () => {
    const db = buildDb(seedRequest());
    await RequestRepository.update(
      'r-1',
      {
        subject: 'Editado',
        status: 'cerrado',
        dateTime: '2026-07-14T10:00:00.000Z',
        clientId: 'ca-2',
        siteId: 'si-2',
        station: 'st-2',
        guardId: 'sg-2',
        incidentTypeId: 'it-2',
      },
      repoOptions(db),
    );
    const row = db.request.rows[0];
    assert.strictEqual(row.subject, 'Editado');
    assert.strictEqual(row.dateTime, '2026-07-14T10:00:00.000Z');
    assert.strictEqual(row.clientId, 'ca-2');
    assert.strictEqual(row.siteId, 'si-2');
    assert.strictEqual(row.stationId, 'st-2', 'station alias not mapped to stationId');
    assert.strictEqual(row.guardNameId, 'sg-2', 'guardId alias not mapped to guardNameId');
    assert.strictEqual(row.incidentTypeId, 'it-2');
  });

  it("update of another tenant's request throws 404 and writes nothing", async () => {
    const db = buildDb({ requests: [{ id: 'r-1', tenantId: OTHER_TENANT, subject: 'ajeno', deletedAt: null }] });
    await assert.rejects(
      () => RequestRepository.update('r-1', { status: 'cerrado' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.request.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════ D · ServiceRepository duplicate guard ════════════════
describe('op-visitantes-tareas · ServiceRepository duplicate guard', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  const FULL = { title: 'Guardia 12h', description: 'Cobertura diurna', price: 500, publishedOnMobile: true };

  it('create rejects a duplicate title/description within the tenant with Error400 (nothing created)', async () => {
    const db = buildDb();
    // Simulate an existing row for the duplicate-probe query (Op.or over title/desc).
    db.service.findOne = async (q: any = {}) => (q.where && q.where[Op.or] ? makeRow({ id: 'svc-existing' }) : null);
    await assert.rejects(() => ServiceRepository.create({ ...FULL }, repoOptions(db)), (e: any) => e instanceof Error400);
    assert.strictEqual(db.service.calls.create.length, 0, 'a duplicate service must not be inserted');
  });

  it('create succeeds when no duplicate exists (title/desc are free)', async () => {
    const db = buildDb();
    await ServiceRepository.create({ ...FULL }, repoOptions(db));
    assert.strictEqual(db.service.calls.create.length, 1);
    const written = db.service.calls.create[0];
    assert.strictEqual(written.title, 'Guardia 12h');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('update dup-check EXCLUDES the row itself (renaming to the same title is allowed)', async () => {
    const db = buildDb({ services: [{ id: 'svc-1', tenantId: TENANT, ...FULL, deletedAt: null }] });
    const seenQueries: any[] = [];
    const realFindOne = db.service.findOne;
    db.service.findOne = async (q: any = {}) => {
      seenQueries.push(q);
      return realFindOne(q);
    };
    // Same title, only price changed — must NOT trip the duplicate guard.
    await ServiceRepository.update('svc-1', { ...FULL, price: 999 }, repoOptions(db));
    assert.strictEqual(db.service.rows[0].price, 999, 'legit self-update rejected as duplicate');
    // The dup-probe query must carry an id != self exclusion.
    const dupProbe = seenQueries.find((q) => q.where && q.where.id && q.where.id[Op.ne]);
    assert.ok(dupProbe, 'update dup-check did not exclude the row itself (id <> self)');
    assert.strictEqual(dupProbe.where.id[Op.ne], 'svc-1');
  });

  it('update rejects when ANOTHER service already owns the new title (Error400, no write)', async () => {
    const db = buildDb({ services: [{ id: 'svc-1', tenantId: TENANT, title: 'Original', deletedAt: null }] });
    db.service.findOne = async (q: any = {}) => {
      if (q.where && q.where.id && !q.where.id[Op.ne]) return makeRow({ id: 'svc-1', tenantId: TENANT, title: 'Original' });
      if (q.where && q.where[Op.or]) return makeRow({ id: 'svc-2' }); // a different row owns the title
      return null;
    };
    await assert.rejects(
      () => ServiceRepository.update('svc-1', { title: 'Colisión' }, repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.service.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════ E · public share flow (no-auth) ══════════════════════
describe('op-visitantes-tareas · RequestShareRepository.findByToken (TTL)', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  it('returns a share whose token matches and is not expired', async () => {
    const future = new Date(Date.now() + 60_000);
    const db = buildDb({
      requestShares: [{ id: 'sh-1', tenantId: TENANT, requestId: 'r-1', token: 'Tok', expiresAt: future }],
    });
    const share = await RequestShareRepository.findByToken('Tok', { database: db } as any);
    assert.ok(share, 'valid non-expired token not found');
    assert.strictEqual((share as any).requestId, 'r-1');
  });

  it('returns a share with a null (never-expiring) expiry', async () => {
    const db = buildDb({
      requestShares: [{ id: 'sh-1', tenantId: TENANT, requestId: 'r-1', token: 'Tok', expiresAt: null }],
    });
    const share = await RequestShareRepository.findByToken('Tok', { database: db } as any);
    assert.ok(share, 'never-expiring token must resolve');
  });

  it('does NOT return an expired share (expiresAt in the past)', async () => {
    const past = new Date(Date.now() - 60_000);
    const db = buildDb({
      requestShares: [{ id: 'sh-1', tenantId: TENANT, requestId: 'r-1', token: 'Tok', expiresAt: past }],
    });
    const share = await RequestShareRepository.findByToken('Tok', { database: db } as any);
    assert.strictEqual(share, null, 'an expired share token must not resolve');
  });
});

describe('op-visitantes-tareas · publicRequest handler (no-auth token)', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  function fakeRes() {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  }

  it('400 when the token param is missing', async () => {
    const db = buildDb();
    const res = fakeRes();
    await publicRequest({ params: {}, database: db } as any, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('404 when the token is unknown/expired', async () => {
    const db = buildDb();
    const res = fakeRes();
    await publicRequest({ params: { token: 'nope' }, database: db } as any, res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('valid token returns the tenant-scoped request payload (no auth required)', async () => {
    const db = buildDb({
      requestShares: [{ id: 'sh-1', tenantId: TENANT, requestId: 'r-1', token: 'Tok', expiresAt: null }],
      requests: [{ id: 'r-1', tenantId: TENANT, subject: 'Compartida', content: 'detalle', deletedAt: null }],
    });
    const res = fakeRes();
    await publicRequest({ params: { token: 'Tok' }, database: db } as any, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body, 'no request payload returned');
    assert.strictEqual(res.body.id, 'r-1');
    assert.strictEqual(res.body.subject, 'Compartida');
  });

  it("does NOT leak a request from another tenant even if the share row is malformed", async () => {
    // Share points at r-1 but claims tenant-B; the request is in tenant-A →
    // RequestRepository.findById(tenant-B) must miss → 404, not a cross-tenant read.
    const db = buildDb({
      requestShares: [{ id: 'sh-1', tenantId: OTHER_TENANT, requestId: 'r-1', token: 'Tok', expiresAt: null }],
      requests: [{ id: 'r-1', tenantId: TENANT, subject: 'Secreta', deletedAt: null }],
    });
    const res = fakeRes();
    await publicRequest({ params: { token: 'Tok' }, database: db } as any, res);
    assert.notStrictEqual(res.statusCode, 200, 'cross-tenant request leaked through a share token');
    // FIXED: a not-found (incl. cross-tenant) now returns 404, not a 500 that
    // blamed the server for a plain missing request.
    assert.strictEqual(res.statusCode, 404, 'findById miss → 404');
  });
});

// ═══════════════════════ F · feedback handler (app rating) ════════════════════
describe('op-visitantes-tareas · feedback handler (app rating)', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  // The module registers app.post(path, handler); capture the handler to invoke.
  function loadHandler() {
    let handler: any;
    feedbackModule({ post: (_p: string, h: any) => { handler = h; } } as any);
    return handler;
  }

  function fakeReqRes(db: any, body: any, over: any = {}) {
    const req: any = {
      database: db,
      currentTenant: { id: TENANT },
      currentUser: { id: USER_ID },
      language: 'es',
      body,
      ...over,
    };
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.send = (b: any) => { res.body = b; return res; };
    res.sendStatus = (c: number) => { res.statusCode = c; return res; };
    return { req, res };
  }

  it('persists a valid rating + comment with tenant/user stamps and source=crm', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { rating: 4, comment: 'Muy útil' } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.appFeedback.calls.create[0];
    assert.ok(written, 'no feedback row written');
    assert.strictEqual(written.rating, 4);
    assert.strictEqual(written.comment, 'Muy útil');
    assert.strictEqual(written.source, 'crm');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.userId, USER_ID);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('a MISSING rating is a 400 — NOT a phantom row', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { comment: 'sin estrellas' } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.appFeedback.calls.create.length, 0, 'a ratingless feedback must not persist');
  });

  it('a garbage (non-numeric) rating is a 400 — NOT a phantom 1-star row', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { rating: 'abc' } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.appFeedback.calls.create.length, 0);
  });

  it('clamps an out-of-range rating into 1..5 (7 → 5)', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { rating: 7 } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.appFeedback.calls.create[0].rating, 5, 'rating not clamped to the 1..5 range');
  });

  it('rating with no comment persists comment=null (comment is optional)', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { rating: 5 } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.appFeedback.calls.create[0].comment, null);
  });

  it('caps an overly long comment to 2000 chars', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const long = 'x'.repeat(5000);
    const { req, res } = fakeReqRes(db, { data: { rating: 3, comment: long } });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.appFeedback.calls.create[0].comment.length, 2000, 'comment not capped');
  });

  it('an unauthenticated request (no currentUser) is a 400, not a write', async () => {
    const db = buildDb();
    const handler = loadHandler();
    const { req, res } = fakeReqRes(db, { data: { rating: 5 } }, { currentUser: undefined });
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.appFeedback.calls.create.length, 0);
  });
});
