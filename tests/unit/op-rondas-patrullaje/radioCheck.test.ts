/**
 * Unit tests — Radio Check (pase de novedades) engine.
 *
 * Exercises the REAL src/services/radioCheckService.ts against an in-memory,
 * Sequelize-shaped fake db (no MySQL, no network). The side channels
 * (storePlatformEvent → socket.io/CRM, the FCM channel adapter, the AI
 * transcription/summary, the live voice broadcast) are stubbed so the DB state
 * machine is what's under test:
 *
 *   - upsertSettings   whitelist + clamping (interval 1..720, timeout 30..1800)
 *   - getSettings      lazy-create the tenant row with the default prompt
 *   - submitReply      auth (403 wrong station / 404 unknown), classification
 *                      (canned/text/voice), first-reply-wins, clientMsgId idempotency
 *   - advanceSession   timeout notified→no_response, notify next pending, complete
 *   - cancelSession    notified→no_response, pending→skipped
 *   - getPendingForGuard  only a NOTIFIED entry of a RUNNING session
 *
 * NOT covered by existing suites (radio-check has no unit tests). Tenant
 * isolation is manual in this engine, so every assertion pins the tenant filter.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rondas-patrullaje/radioCheck.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize, { Op } from 'sequelize';

import * as radio from '../../../src/services/radioCheckService';
import * as assignedStations from '../../../src/services/assignedStationsService';
import * as platformEventStore from '../../../src/lib/platformEventStore';
import * as radioVoice from '../../../src/lib/radioVoice';
import * as ai from '../../../src/services/radioCheckAiService';
import * as channelAdapter from '../../../src/services/radio/channelAdapter';

const TENANT = 'tenant-A';

// ─────────────────────────── fake db (Sequelize-shaped) ──────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    async update(patch: any) { for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v; return row; },
    async increment(field: string) { row[field] = (row[field] || 0) + 1; return row; },
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) { if (typeof row[k] === 'function') continue; plain[k] = row[k]; }
      return opts && opts.plain ? { ...plain } : plain;
    },
  };
  return row;
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    const cond = (where as any)[key];
    // Op.or
    if ((key as any) === (Op.or as any)) continue;
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const s of Object.getOwnPropertySymbols(cond)) {
        const v = (cond as any)[s];
        if (s === Op.in && !(Array.isArray(v) && v.includes(row[key]))) return false;
        if (s === Op.lt && !(row[key] != null && new Date(row[key]).getTime() < new Date(v).getTime())) return false;
        if (s === Op.ne && row[key] === v) return false;
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  // Op.or handling (array of clauses)
  if ((where as any)[Op.or]) {
    const clauses = (where as any)[Op.or];
    if (!clauses.some((c: any) => matchWhere(row, c))) return false;
  }
  return true;
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    rows: seed.map(makeRow),
    calls: { create: [] as any[], update: [] as any[] },
    async create(data: any) {
      model.calls.create.push({ ...data });
      const r = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data });
      model.rows.push(r);
      return r;
    },
    async findOne(q: any = {}) {
      let rows = model.rows.filter((r: any) => matchWhere(r, q.where));
      if (q.order && q.order.length) {
        const [col, dir] = q.order[0];
        rows = rows.slice().sort((a: any, b: any) => {
          const av = a[col], bv = b[col];
          const cmp = new Date(av || 0).getTime() - new Date(bv || 0).getTime();
          return dir === 'DESC' ? -cmp : cmp;
        });
      }
      return rows[0] || null;
    },
    async findAll(q: any = {}) {
      let rows = model.rows.filter((r: any) => matchWhere(r, q.where));
      if (q.order && q.order.length) {
        const [col, dir] = q.order[0];
        rows = rows.slice().sort((a: any, b: any) => {
          const cmp = (a[col] ?? 0) > (b[col] ?? 0) ? 1 : (a[col] ?? 0) < (b[col] ?? 0) ? -1 : 0;
          return dir === 'DESC' ? -cmp : cmp;
        });
      }
      return rows;
    },
    // Sequelize static update → [affectedCount]
    async update(patch: any, q: any = {}) {
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      for (const r of victims) for (const [k, v] of Object.entries(patch)) if (v !== undefined) r[k] = v;
      model.calls.update.push({ patch, where: q.where, affected: victims.length });
      return [victims.length];
    },
    async increment(field: string, q: any = {}) {
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      for (const r of victims) r[field] = (r[field] || 0) + 1;
      return [victims.length];
    },
  };
  return model;
}

function buildDb(seed: {
  settings?: any[];
  sessions?: any[];
  entries?: any[];
} = {}) {
  return {
    Sequelize,
    radioCheckSettings: makeModel('rcs', seed.settings || []),
    radioCheckSession: makeModel('sess', seed.sessions || []),
    radioCheckEntry: makeModel('entry', seed.entries || []),
    station: makeModel('station', []),
    securityGuard: makeModel('sg', []),
    guardShift: makeModel('gs', []),
    supervisorProfile: makeModel('sp', []),
  } as any;
}

function stubSideChannels() {
  sinon.stub(platformEventStore, 'storePlatformEvent').resolves();
  sinon.stub(radioVoice, 'broadcastPcm').resolves(undefined as any);
  sinon.stub(ai, 'transcribeEntry').resolves(undefined as any);
  sinon.stub(ai, 'generateSummary').resolves(undefined as any);
  sinon.stub(ai, 'broadcastOpening').resolves(undefined as any);
  sinon.stub(ai, 'synthesizeSpeech').resolves(null as any);
  sinon.stub(ai, 'synthesizeSpeechPcm').resolves(null as any);
  sinon.stub(ai, 'buildStationPromptText').returns('prompt');
  sinon.stub(channelAdapter, 'getChannelAdapter').returns({ notifyGuards: async () => {} } as any);
}

// ═══════════════════════════ settings ════════════════════════════════════════
describe('op-rondas · radioCheck settings', () => {
  afterEach(() => sinon.restore());

  it('getSettings lazily creates the tenant row with the default prompt', async () => {
    const db = buildDb();
    const s = await radio.getSettings(db, TENANT);
    assert.strictEqual(db.radioCheckSettings.calls.create.length, 1);
    assert.strictEqual(s.tenantId, TENANT);
    assert.ok(/novedades/i.test(s.promptText), 'default prompt seeded');
  });

  it('getSettings returns the existing row without re-creating it', async () => {
    const db = buildDb({ settings: [{ id: 'rcs-1', tenantId: TENANT, promptText: 'Custom', deletedAt: null }] });
    const s = await radio.getSettings(db, TENANT);
    assert.strictEqual(db.radioCheckSettings.calls.create.length, 0);
    assert.strictEqual(s.promptText, 'Custom');
  });

  it('upsertSettings persists only whitelisted fields (ignores injected columns)', async () => {
    const db = buildDb({ settings: [{ id: 'rcs-1', tenantId: TENANT, enabled: false, promptText: 'x', deletedAt: null }] });
    const s = await radio.upsertSettings(db, TENANT, {
      enabled: true, promptText: 'Reporte', channel: 'app', voiceAnnouncement: true,
      tenantId: 'tenant-EVIL', id: 'hijack', incidentCount: 999,
    }, 'user-1');
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.promptText, 'Reporte');
    assert.strictEqual(s.tenantId, TENANT, 'tenantId not mass-assignable');
    assert.strictEqual(s.id, 'rcs-1', 'id not mass-assignable');
    assert.notStrictEqual((s as any).incidentCount, 999, 'non-whitelisted field ignored');
    assert.strictEqual(s.updatedById, 'user-1');
  });

  it('upsertSettings clamps intervalMinutes to [1,720] and perStationTimeoutSeconds to [30,1800]', async () => {
    const db = buildDb({ settings: [{ id: 'rcs-1', tenantId: TENANT, deletedAt: null }] });
    const hi = await radio.upsertSettings(db, TENANT, { intervalMinutes: 5000, perStationTimeoutSeconds: 99999 });
    assert.strictEqual(hi.intervalMinutes, 720, 'interval clamped to max');
    assert.strictEqual(hi.perStationTimeoutSeconds, 1800, 'timeout clamped to max');

    // A below-range value clamps up to the floor (negative is truthy so it is
    // NOT replaced by the default first).
    const lo = await radio.upsertSettings(db, TENANT, { intervalMinutes: -5, perStationTimeoutSeconds: 1 });
    assert.strictEqual(lo.intervalMinutes, 1, 'interval clamped to min');
    assert.strictEqual(lo.perStationTimeoutSeconds, 30, 'timeout clamped to min');
  });
});

// ═══════════════════════════ submitReply ═════════════════════════════════════
describe('op-rondas · radioCheck submitReply', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  const seedEntry = (over: any = {}) => ({
    id: 'e-1', tenantId: TENANT, sessionId: 's-1', stationId: 'st-1', stationName: 'Puesto 1',
    guardUserId: 'guard-1', status: 'notified', classification: 'unknown', transcriptStatus: 'skipped',
    clientMsgId: null, deletedAt: null, ...over,
  });
  const seedSession = (over: any = {}) => ({ id: 's-1', tenantId: TENANT, status: 'running', deletedAt: null, respondedCount: 0, incidentCount: 0, ...over });

  it('404s an unknown entry', async () => {
    const db = buildDb({ sessions: [seedSession()] });
    await assert.rejects(
      radio.submitReply(db, TENANT, 'nope', 'guard-1', {}),
      (e: any) => e.code === 404,
    );
  });

  it('403s a guard who is neither the targeted user nor assigned to the station', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]); // intruder assigned nowhere
    const db = buildDb({ sessions: [seedSession()], entries: [seedEntry()] });
    await assert.rejects(
      radio.submitReply(db, TENANT, 'e-1', 'intruder', {}),
      (e: any) => e.code === 403,
    );
    assert.strictEqual(db.radioCheckEntry.rows[0].status, 'notified', 'entry not mutated by an unauthorized reply');
  });

  it('a canned reply → classification sin_novedad, status responded, respondedCount incremented', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({ sessions: [seedSession()], entries: [seedEntry()] });
    const fresh = await radio.submitReply(db, TENANT, 'e-1', 'guard-1', { cannedText: 'Sin novedad' });
    assert.strictEqual(fresh.status, 'responded');
    assert.strictEqual(fresh.classification, 'sin_novedad');
    assert.strictEqual(fresh.replyKind, 'canned');
    assert.strictEqual(db.radioCheckSession.rows[0].respondedCount, 1);
  });

  it('a free-text reply mentioning an emergency → classification incident (+incidentCount)', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({ sessions: [seedSession()], entries: [seedEntry()] });
    const fresh = await radio.submitReply(db, TENANT, 'e-1', 'guard-1', { text: 'Hay un incendio en la bodega' });
    assert.strictEqual(fresh.classification, 'incident');
    assert.strictEqual(fresh.transcript, 'Hay un incendio en la bodega');
    assert.strictEqual(fresh.replyKind, 'text');
    assert.strictEqual(db.radioCheckSession.rows[0].incidentCount, 1, 'incident tally bumped');
  });

  it('a voice reply stores the audio url and defers transcription (status pending)', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({ sessions: [seedSession()], entries: [seedEntry()] });
    const fresh = await radio.submitReply(db, TENANT, 'e-1', 'guard-1', { audioUrl: 'https://x/a.mp3' });
    assert.strictEqual(fresh.replyKind, 'voice');
    assert.strictEqual(fresh.audioUrl, 'https://x/a.mp3');
    assert.strictEqual(fresh.transcriptStatus, 'pending');
    assert.ok((ai.transcribeEntry as sinon.SinonStub).called, 'out-of-band transcription kicked off');
  });

  it('first reply wins — a second reply on an already-responded entry does not overwrite it', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({
      sessions: [seedSession({ respondedCount: 1 })],
      entries: [seedEntry({ status: 'responded', classification: 'sin_novedad', transcript: 'Sin novedad' })],
    });
    const res = await radio.submitReply(db, TENANT, 'e-1', 'guard-1', { text: 'incendio' });
    assert.strictEqual(res.classification, 'sin_novedad', 'original reply preserved');
    assert.strictEqual(db.radioCheckSession.rows[0].respondedCount, 1, 'no double count');
  });

  it('idempotent on clientMsgId — a retry returns the stored entry unchanged', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({
      sessions: [seedSession()],
      entries: [seedEntry({ status: 'responded', clientMsgId: 'cm-9', classification: 'sin_novedad' })],
    });
    const res = await radio.submitReply(db, TENANT, 'e-1', 'guard-1', { text: 'incendio', clientMsgId: 'cm-9' });
    assert.strictEqual(res.classification, 'sin_novedad');
    assert.strictEqual(db.radioCheckSession.rows[0].respondedCount, 0, 'retry does not re-tally');
  });

  it('authorizes by station assignment when the replier is not the targeted user', async () => {
    // Targeted guard is guard-1; a different guard assigned to the SAME station may answer.
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves(['st-1']);
    const db = buildDb({ sessions: [seedSession()], entries: [seedEntry({ guardUserId: 'guard-1' })] });
    const fresh = await radio.submitReply(db, TENANT, 'e-1', 'guard-2', { cannedText: 'Sin novedad' });
    assert.strictEqual(fresh.status, 'responded');
    assert.strictEqual(fresh.guardUserId, 'guard-2', 'answering guard recorded');
  });
});

// ═══════════════════════════ advanceSession ══════════════════════════════════
describe('op-rondas · radioCheck advanceSession state machine', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  const runningSession = (over: any = {}) => ({ id: 's-1', tenantId: TENANT, status: 'running', deletedAt: null, noResponseCount: 0, ...over });

  it('expires a timed-out notified entry to no_response and bumps noResponseCount', async () => {
    const past = new Date(Date.now() - 60_000);
    const db = buildDb({
      settings: [{ id: 'rcs-1', tenantId: TENANT, perStationTimeoutSeconds: 180 }],
      sessions: [runningSession()],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', timeoutAt: past, stationName: 'P1', deletedAt: null }],
    });
    await radio.advanceSession(db, TENANT, 's-1');
    assert.strictEqual(db.radioCheckEntry.rows[0].status, 'no_response', 'stale entry expired');
    assert.strictEqual(db.radioCheckSession.rows[0].noResponseCount, 1);
  });

  it('notifies the next pending entry (pending → notified with a timeout window)', async () => {
    const db = buildDb({
      settings: [{ id: 'rcs-1', tenantId: TENANT, perStationTimeoutSeconds: 180 }],
      sessions: [runningSession()],
      entries: [
        { id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'pending', seq: 0, stationId: 'st-1', stationName: 'P1', deletedAt: null },
        { id: 'e-2', tenantId: TENANT, sessionId: 's-1', status: 'pending', seq: 1, stationId: 'st-2', stationName: 'P2', deletedAt: null },
      ],
    });
    await radio.advanceSession(db, TENANT, 's-1');
    const e1 = db.radioCheckEntry.rows.find((r: any) => r.id === 'e-1');
    assert.strictEqual(e1.status, 'notified', 'lowest-seq pending is called next');
    assert.ok(e1.timeoutAt instanceof Date, 'a response window is opened');
    assert.strictEqual(db.radioCheckEntry.rows.find((r: any) => r.id === 'e-2').status, 'pending', 'only one advanced at a time');
  });

  it('waits (no completion) while an entry is still notified within its window', async () => {
    const future = new Date(Date.now() + 60_000);
    const db = buildDb({
      settings: [{ id: 'rcs-1', tenantId: TENANT, perStationTimeoutSeconds: 180 }],
      sessions: [runningSession()],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', timeoutAt: future, stationName: 'P1', deletedAt: null }],
    });
    await radio.advanceSession(db, TENANT, 's-1');
    assert.strictEqual(db.radioCheckSession.rows[0].status, 'running', 'session stays running while waiting');
    assert.strictEqual(db.radioCheckEntry.rows[0].status, 'notified', 'active entry untouched');
  });

  it('completes the session when nothing is pending or notified', async () => {
    const db = buildDb({
      settings: [{ id: 'rcs-1', tenantId: TENANT, perStationTimeoutSeconds: 180 }],
      sessions: [runningSession()],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'responded', stationName: 'P1', deletedAt: null }],
    });
    await radio.advanceSession(db, TENANT, 's-1');
    assert.strictEqual(db.radioCheckSession.rows[0].status, 'completed');
    assert.ok(db.radioCheckSession.rows[0].completedAt instanceof Date);
  });

  it('is a no-op for a session that is not running', async () => {
    const db = buildDb({
      settings: [{ id: 'rcs-1', tenantId: TENANT }],
      sessions: [runningSession({ status: 'completed' })],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'pending', seq: 0, deletedAt: null }],
    });
    await radio.advanceSession(db, TENANT, 's-1');
    assert.strictEqual(db.radioCheckEntry.rows[0].status, 'pending', 'no advancement on a finished session');
  });
});

// ═══════════════════════════ cancelSession ═══════════════════════════════════
describe('op-rondas · radioCheck cancelSession', () => {
  beforeEach(() => stubSideChannels());
  afterEach(() => sinon.restore());

  it('cancels a running session and terminates dangling entries (notified→no_response, pending→skipped)', async () => {
    const db = buildDb({
      sessions: [{ id: 's-1', tenantId: TENANT, status: 'running', deletedAt: null }],
      entries: [
        { id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', deletedAt: null },
        { id: 'e-2', tenantId: TENANT, sessionId: 's-1', status: 'pending', deletedAt: null },
        { id: 'e-3', tenantId: TENANT, sessionId: 's-1', status: 'responded', deletedAt: null },
      ],
    });
    await radio.cancelSession(db, TENANT, 's-1');
    assert.strictEqual(db.radioCheckSession.rows[0].status, 'cancelled');
    const byId = (id: string) => db.radioCheckEntry.rows.find((r: any) => r.id === id).status;
    assert.strictEqual(byId('e-1'), 'no_response', 'in-flight notified → no_response');
    assert.strictEqual(byId('e-2'), 'skipped', 'never-reached pending → skipped');
    assert.strictEqual(byId('e-3'), 'responded', 'already-answered entry preserved');
  });
});

// ═══════════════════════════ getPendingForGuard ══════════════════════════════
describe('op-rondas · radioCheck getPendingForGuard', () => {
  afterEach(() => sinon.restore());

  it('returns a notified entry targeted to the guard when its session is running', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({
      sessions: [{ id: 's-1', tenantId: TENANT, status: 'running', deletedAt: null }],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', guardUserId: 'guard-1', notifiedAt: new Date(), deletedAt: null }],
    });
    const entry = await radio.getPendingForGuard(db, TENANT, 'guard-1');
    assert.ok(entry);
    assert.strictEqual(entry.id, 'e-1');
  });

  it('returns null when the entry belongs to a session that is no longer running', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({
      sessions: [{ id: 's-1', tenantId: TENANT, status: 'completed', deletedAt: null }],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', guardUserId: 'guard-1', notifiedAt: new Date(), deletedAt: null }],
    });
    const entry = await radio.getPendingForGuard(db, TENANT, 'guard-1');
    assert.strictEqual(entry, null, 'a stale notified entry from a finished session must not surface');
  });

  it('does not surface another guard\'s entry (no station assignment overlap)', async () => {
    sinon.stub(assignedStations, 'stationIdsForGuard').resolves([]);
    const db = buildDb({
      sessions: [{ id: 's-1', tenantId: TENANT, status: 'running', deletedAt: null }],
      entries: [{ id: 'e-1', tenantId: TENANT, sessionId: 's-1', status: 'notified', guardUserId: 'guard-OTHER', stationId: 'st-9', notifiedAt: new Date(), deletedAt: null }],
    });
    const entry = await radio.getPendingForGuard(db, TENANT, 'guard-1');
    assert.strictEqual(entry, null);
  });
});
