/**
 * Unit tests — tasks / memos / station-orders / radio-check (pase de novedades).
 *
 * Mirrors the style of backend/src/services/communication/__tests__/routing.test.ts:
 * an in-memory fake `db` (NO MySQL, NO network) + sinon to stub the few external
 * fan-out calls (push / platform events / AI). The REAL services run end-to-end.
 *
 * Coverage:
 *   A. classifyText (PURE)              — Spanish keyword classifier for replies.
 *   B. consignaRecurrence (PURE)        — isDueOn / dueAt / ymd, tenant-tz aware.
 *   C. radioCheckService.submitReply    — first-reply-wins, authorization, canned
 *                                          vs text classification, against fake db.
 *   D. TaskApprovalService.decide/list  — CRM approve/reject + queue listing.
 *
 * Run:
 *   cd backend && cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/tasks-memos-orders/tasksMemosOrders.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import { Op } from 'sequelize';

import { classifyText } from '../../../src/services/radio/classify';
import { isDueOn, dueAt, ymd } from '../../../src/services/consignaRecurrence';
import * as radioCheckService from '../../../src/services/radioCheckService';
import TaskApprovalService from '../../../src/services/taskApprovalService';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ───────────────────────────── fake row + db ─────────────────────────────────

function makeRow(data: any) {
  return {
    ...data,
    get(opts?: any) {
      return opts && opts.plain ? { ...data } : data;
    },
    async update(patch: any) {
      Object.assign(data, patch);
      Object.assign(this, patch);
      return this;
    },
    async increment(field: string) {
      data[field] = (data[field] || 0) + 1;
      (this as any)[field] = data[field];
      return this;
    },
  };
}

/** Tiny Sequelize-shaped stub for the radioCheckEntry/session models. */
function buildRadioDb(opts: {
  entries?: any[];
  sessions?: any[];
  /** station.id -> array of assigned user ids (for guardStationIds resolution). */
  guardStations?: Record<string, string[]>;
} = {}) {
  const entries = (opts.entries || []).map(makeRow);
  const sessions = (opts.sessions || []).map(makeRow);
  const guardStations = opts.guardStations || {};

  const matchEntry = (e: any, where: any) => {
    if (where.id && e.id !== where.id) return false;
    if (where.tenantId && e.tenantId !== where.tenantId) return false;
    if (where.sessionId && e.sessionId !== where.sessionId) return false;
    if (where.status) {
      if (where.status[Op.in]) {
        if (!where.status[Op.in].includes(e.status)) return false;
      } else if (e.status !== where.status) return false;
    }
    if (where.deletedAt === null && e.deletedAt != null) return false;
    return true;
  };

  const db: any = {
    Sequelize: { Op },
    radioCheckEntry: {
      async findOne({ where }: any) {
        return entries.find((e) => matchEntry(e, where)) || null;
      },
      async findAll({ where }: any) {
        return entries.filter((e) => matchEntry(e, where));
      },
      // conditional UPDATE → [affectedCount]
      async update(patch: any, { where }: any) {
        const target = entries.filter((e) => matchEntry(e, where));
        target.forEach((e) => e.update(patch));
        return [target.length];
      },
    },
    radioCheckSession: {
      async findOne({ where }: any) {
        return (
          sessions.find((s) => {
            if (where.id && s.id !== where.id) return false;
            if (where.tenantId && s.tenantId !== where.tenantId) return false;
            if (where.status && s.status !== where.status) return false;
            return true;
          }) || null
        );
      },
      async update() {
        return [0];
      },
    },
    // guardStationIds() resolves stations the user is assigned to via assignedGuards.
    station: {
      async findAll({ include }: any) {
        const inc = (include || [])[0];
        const wantUserId = inc?.where?.id;
        const out: any[] = [];
        for (const [stationId, users] of Object.entries(guardStations)) {
          if (!wantUserId || (users as string[]).includes(wantUserId)) {
            out.push(makeRow({ id: stationId }));
          }
        }
        return out;
      },
    },
    // The service now authorizes replies via stationIdsForGuard() →
    // guardAssignment.findAll (the single guard↔station store), not the old
    // station↔assignedGuards pivot. Derive it from the same guardStations map.
    guardAssignment: {
      async findAll({ where }: any) {
        const wantUserId = where?.guardId;
        const out: any[] = [];
        for (const [stationId, users] of Object.entries(guardStations)) {
          if (wantUserId && (users as string[]).includes(wantUserId)) {
            out.push(makeRow({ stationId }));
          }
        }
        return out;
      },
    },
  };
  return { db, entries, sessions };
}

// ───────────────────────────────── A. classifyText ───────────────────────────

describe('tasks-memos-orders — classifyText (radio reply classifier)', () => {
  it('flags an incident on emergency keywords', () => {
    assert.strictEqual(classifyText('Hay un robo en la entrada'), 'incident');
    assert.strictEqual(classifyText('Reporto un incendio'), 'incident');
    assert.strictEqual(classifyText('persona sospechosa merodeando'), 'incident');
  });

  it('recognizes "sin novedad" canned variants', () => {
    assert.strictEqual(classifyText('Sin novedad'), 'sin_novedad');
    assert.strictEqual(classifyText('Todo tranquilo por aquí'), 'sin_novedad');
    assert.strictEqual(classifyText('Nada que reportar'), 'sin_novedad');
  });

  it('falls back to "novedad" for any other non-empty text', () => {
    assert.strictEqual(classifyText('Llegó una visita al lobby'), 'novedad');
  });

  it('returns "unknown" for empty / whitespace input', () => {
    assert.strictEqual(classifyText(''), 'unknown');
    assert.strictEqual(classifyText('   '), 'unknown');
    assert.strictEqual(classifyText(null as any), 'unknown');
  });

  it('incident takes precedence over a sin-novedad phrase in the same text', () => {
    // contains both "todo bien" and "disparo" → incident wins.
    assert.strictEqual(classifyText('todo bien pero escuché un disparo'), 'incident');
  });
});

// ───────────────────────────── B. consignaRecurrence ─────────────────────────

describe('tasks-memos-orders — consignaRecurrence (station orders due logic)', () => {
  // 2026-06-24 is a Wednesday. Use noon UTC to stay clear of tz date flips.
  const wed = new Date('2026-06-24T12:00:00Z');
  const sat = new Date('2026-06-27T12:00:00Z');
  const sun = new Date('2026-06-28T12:00:00Z');

  it('daily is always due', () => {
    assert.strictEqual(isDueOn({ recurrence: 'daily' }, wed, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'daily' }, sun, 'UTC'), true);
  });

  it('weekdays is due Mon–Fri, not on the weekend', () => {
    assert.strictEqual(isDueOn({ recurrence: 'weekdays' }, wed, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'weekdays' }, sat, 'UTC'), false);
    assert.strictEqual(isDueOn({ recurrence: 'weekdays' }, sun, 'UTC'), false);
  });

  it('weekend is due Sat/Sun only', () => {
    assert.strictEqual(isDueOn({ recurrence: 'weekend' }, wed, 'UTC'), false);
    assert.strictEqual(isDueOn({ recurrence: 'weekend' }, sat, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'weekend' }, sun, 'UTC'), true);
  });

  it('weekly matches the configured day-of-week set (Wed = 3)', () => {
    assert.strictEqual(isDueOn({ recurrence: 'weekly', days: [3] }, wed, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'weekly', days: [1, 5] }, wed, 'UTC'), false);
    // accepts a JSON-string days payload too
    assert.strictEqual(isDueOn({ recurrence: 'weekly', days: '[3]' }, wed, 'UTC'), true);
  });

  it('monthly matches the configured day-of-month', () => {
    assert.strictEqual(isDueOn({ recurrence: 'monthly', dayOfMonth: 24 }, wed, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'monthly', dayOfMonth: 25 }, wed, 'UTC'), false);
  });

  it('once matches only on the configured date', () => {
    assert.strictEqual(isDueOn({ recurrence: 'once', date: '2026-06-24' }, wed, 'UTC'), true);
    assert.strictEqual(isDueOn({ recurrence: 'once', date: '2026-06-25' }, wed, 'UTC'), false);
    assert.strictEqual(isDueOn({ recurrence: 'once' }, wed, 'UTC'), false);
  });

  it('an unknown recurrence is never due', () => {
    assert.strictEqual(isDueOn({ recurrence: 'lunar' }, wed, 'UTC'), false);
  });

  it('evaluates the day in the tenant timezone, not UTC', () => {
    // 2026-06-25 01:00 UTC is still 2026-06-24 (Wed) 20:00 in Guayaquil (-05).
    const justAfterUtcMidnight = new Date('2026-06-25T01:00:00Z');
    assert.strictEqual(ymd(justAfterUtcMidnight, 'America/Guayaquil'), '2026-06-24');
    // 'once' on the 24th is due when read in tenant tz, even though UTC says the 25th.
    assert.strictEqual(
      isDueOn({ recurrence: 'once', date: '2026-06-24' }, justAfterUtcMidnight, 'America/Guayaquil'),
      true,
    );
  });

  it('dueAt builds the occurrence instant from tenant-local date + order time', () => {
    // 08:30 local in Guayaquil (-05:00) → 13:30 UTC on the same calendar day.
    const at = dueAt({ time: '08:30' }, wed, 'America/Guayaquil');
    assert.strictEqual(at.toISOString(), '2026-06-24T13:30:00.000Z');
  });
});

// ───────────────────────── C. radioCheckService.submitReply ──────────────────

describe('tasks-memos-orders — radioCheckService.submitReply', () => {
  let storeStub: sinon.SinonStub;
  let aiStub: sinon.SinonStub | undefined;

  beforeEach(() => {
    // Stub the best-effort fan-out so no socket/AI/scheduler side effects fire.
    // platformEventStore.storePlatformEvent is imported by the service module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const platformEventStore = require('../../../src/lib/platformEventStore');
    storeStub = sinon.stub(platformEventStore, 'storePlatformEvent').resolves();
  });
  afterEach(() => sinon.restore());

  function seedNotifiedEntry(extra: any = {}) {
    return buildRadioDb({
      entries: [
        {
          id: 'entry-1',
          tenantId: TENANT_A,
          sessionId: 'sess-1',
          stationId: 'st-1',
          stationName: 'Puesto 1',
          guardUserId: 'guard-1',
          status: 'notified',
          transcript: null,
          transcriptStatus: 'skipped',
          classification: 'unknown',
          clientMsgId: null,
          deletedAt: null,
          ...extra,
        },
      ],
      sessions: [
        { id: 'sess-1', tenantId: TENANT_A, status: 'running', respondedCount: 0, incidentCount: 0 },
      ],
      guardStations: { 'st-1': ['guard-1'] },
    });
  }

  it('records a canned "Sin novedad" reply and classifies it', async () => {
    const { db } = seedNotifiedEntry();
    const fresh = await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-1', {
      cannedText: 'Sin novedad',
    });
    assert.strictEqual(fresh.status, 'responded');
    assert.strictEqual(fresh.replyKind, 'canned');
    assert.strictEqual(fresh.classification, 'sin_novedad');
    assert.strictEqual(fresh.transcript, 'Sin novedad');
    assert.ok(storeStub.called, 'a radio.reply platform event should be emitted');
  });

  it('classifies a free-text incident reply', async () => {
    const { db } = seedNotifiedEntry();
    const fresh = await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-1', {
      text: 'Hay un robo en curso',
    });
    assert.strictEqual(fresh.replyKind, 'text');
    assert.strictEqual(fresh.classification, 'incident');
    assert.strictEqual(fresh.transcript, 'Hay un robo en curso');
  });

  it('first reply wins — a second reply returns the already-responded entry unchanged', async () => {
    const { db, entries } = seedNotifiedEntry();
    await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-1', { cannedText: 'Sin novedad' });
    assert.strictEqual(entries[0].status, 'responded');

    // A racing second reply (different text) must NOT overwrite the first.
    const second = await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-1', {
      text: 'robo robo robo',
    });
    assert.strictEqual(second.status, 'responded');
    assert.strictEqual(second.classification, 'sin_novedad', 'first canned reply must stand');
    assert.strictEqual(entries[0].transcript, 'Sin novedad');
  });

  it('is idempotent on a repeated clientMsgId (returns the stored entry)', async () => {
    const { db } = seedNotifiedEntry({ clientMsgId: 'cmid-42', status: 'responded', classification: 'sin_novedad' });
    const res = await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-1', {
      text: 'should be ignored',
      clientMsgId: 'cmid-42',
    });
    // same clientMsgId → returns existing entry without re-processing.
    assert.strictEqual(res.classification, 'sin_novedad');
    assert.strictEqual(res.status, 'responded');
  });

  it('rejects a guard who is neither the target nor assigned to the station (403)', async () => {
    // entry targets guard-1 / station st-1; an intruder assigned elsewhere replies.
    const { db } = buildRadioDb({
      entries: [
        {
          id: 'entry-1', tenantId: TENANT_A, sessionId: 'sess-1', stationId: 'st-1',
          stationName: 'Puesto 1', guardUserId: 'guard-1', status: 'notified', deletedAt: null,
        },
      ],
      sessions: [{ id: 'sess-1', tenantId: TENANT_A, status: 'running' }],
      guardStations: { 'st-9': ['intruder'] }, // intruder is assigned to st-9, not st-1
    });

    await assert.rejects(
      () => radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'intruder', { text: 'hola' }),
      (err: any) => err.code === 403,
    );
  });

  it('allows a different guard who IS assigned to the entry station', async () => {
    const { db } = buildRadioDb({
      entries: [
        {
          id: 'entry-1', tenantId: TENANT_A, sessionId: 'sess-1', stationId: 'st-1',
          stationName: 'Puesto 1', guardUserId: 'guard-1', status: 'notified',
          classification: 'unknown', transcriptStatus: 'skipped', clientMsgId: null, deletedAt: null,
        },
      ],
      sessions: [{ id: 'sess-1', tenantId: TENANT_A, status: 'running', respondedCount: 0, incidentCount: 0 }],
      guardStations: { 'st-1': ['guard-1', 'guard-2'] }, // guard-2 also covers st-1
    });
    const fresh = await radioCheckService.submitReply(db, TENANT_A, 'entry-1', 'guard-2', {
      cannedText: 'Sin novedad',
    });
    assert.strictEqual(fresh.status, 'responded');
    assert.strictEqual(fresh.guardUserId, 'guard-2', 'reply is attributed to the actual replier');
  });

  it('throws 404 for an unknown entry id', async () => {
    const { db } = seedNotifiedEntry();
    await assert.rejects(
      () => radioCheckService.submitReply(db, TENANT_A, 'nope', 'guard-1', { text: 'hi' }),
      (err: any) => err.code === 404,
    );
  });
});

// ───────────────────── D. TaskApprovalService (CRM approve/reject) ────────────

describe('tasks-memos-orders — TaskApprovalService (CRM approval queue)', () => {
  afterEach(() => sinon.restore());

  /** Fake db with a single `task` model backed by an array, plus station include. */
  function buildTaskDb(seed: any[]) {
    const tasks = seed.map(makeRow);
    const matches = (t: any, where: any) => {
      if (where.id && t.id !== where.id) return false;
      if (where.tenantId && t.tenantId !== where.tenantId) return false;
      if (where.deletedAt === null && t.deletedAt != null) return false;
      if (where.status) {
        const want = Array.isArray(where.status) ? where.status : [where.status];
        if (!want.includes(t.status)) return false;
      }
      return true;
    };
    const db: any = {
      task: {
        async findOne({ where }: any) {
          return tasks.find((t) => matches(t, where)) || null;
        },
        async findAll({ where }: any) {
          return tasks.filter((t) => matches(t, where));
        },
      },
      station: {},
    };
    return { db, tasks };
  }

  const options = (db: any) => ({
    database: db,
    currentTenant: { id: TENANT_A },
    currentUser: { id: 'admin-1' },
    language: 'es',
  });

  it('listByStatus defaults to the pending_approval queue, scoped to tenant', async () => {
    const { db } = buildTaskDb([
      { id: 't1', tenantId: TENANT_A, status: 'pending_approval', taskToDo: 'A', deletedAt: null },
      { id: 't2', tenantId: TENANT_A, status: 'approved', taskToDo: 'B', deletedAt: null },
      { id: 't3', tenantId: TENANT_B, status: 'pending_approval', taskToDo: 'C', deletedAt: null },
    ]);
    const out = await new TaskApprovalService(options(db)).listByStatus();
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.rows[0].id, 't1');
  });

  it('listByStatus(status=all) returns every tenant task (no status filter)', async () => {
    const { db } = buildTaskDb([
      { id: 't1', tenantId: TENANT_A, status: 'pending_approval', deletedAt: null },
      { id: 't2', tenantId: TENANT_A, status: 'completed', deletedAt: null },
    ]);
    const out = await new TaskApprovalService(options(db)).listByStatus({ status: 'all' });
    assert.strictEqual(out.count, 2);
  });

  it('decide(approved) flips status → approved, stamps approver, fires the approved notify', async () => {
    const { db, tasks } = buildTaskDb([
      { id: 't1', tenantId: TENANT_A, status: 'pending_approval', source: 'client',
        taskToDo: 'Revisar cámara', taskBelongsToStationId: 'st-1', clientAccountId: 'c-1', deletedAt: null },
    ]);
    // Stub the fan-out so no real push/email runs; assert it is invoked with the task.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const taskNotify = require('../../../src/services/taskNotify');
    const approved = sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    const rejected = sinon.stub(taskNotify, 'notifyTaskRejected').resolves();

    const plain = await new TaskApprovalService(options(db)).decide('t1', { status: 'approved', notes: 'ok' });

    assert.strictEqual(plain.status, 'approved');
    assert.strictEqual(plain.approvedById, 'admin-1');
    assert.ok(plain.approvedAt, 'approvedAt should be stamped');
    assert.strictEqual(plain.approvalNotes, 'ok');
    assert.strictEqual(tasks[0].status, 'approved', 'the persisted row advanced');
    assert.ok(approved.calledOnce, 'approval notify fan-out fired');
    assert.ok(rejected.notCalled);
  });

  it('decide(rejected) flips status → rejected and fires the rejected notify only', async () => {
    const { db } = buildTaskDb([
      { id: 't1', tenantId: TENANT_A, status: 'pending_approval', taskToDo: 'X',
        taskBelongsToStationId: 'st-1', clientAccountId: 'c-1', deletedAt: null },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const taskNotify = require('../../../src/services/taskNotify');
    const approved = sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    const rejected = sinon.stub(taskNotify, 'notifyTaskRejected').resolves();

    const plain = await new TaskApprovalService(options(db)).decide('t1', { status: 'rejected', notes: 'no procede' });

    assert.strictEqual(plain.status, 'rejected');
    assert.ok(rejected.calledOnce, 'rejection notify fan-out fired');
    assert.ok(approved.notCalled);
    // The reason is passed through to the client notification.
    assert.strictEqual(rejected.firstCall.args[3], 'no procede');
  });

  it('decide throws 404 when the task is not in this tenant', async () => {
    const { db } = buildTaskDb([
      { id: 't1', tenantId: TENANT_B, status: 'pending_approval', deletedAt: null },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const taskNotify = require('../../../src/services/taskNotify');
    sinon.stub(taskNotify, 'notifyTaskApproved').resolves();
    sinon.stub(taskNotify, 'notifyTaskRejected').resolves();

    await assert.rejects(
      () => new TaskApprovalService(options(db)).decide('t1', { status: 'approved' }),
      (err: any) => err && (err.code === 404 || err.status === 404 || /404/.test(String(err))),
    );
  });
});
