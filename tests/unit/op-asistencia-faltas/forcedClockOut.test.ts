/**
 * Unit tests — Salida forzada por fin de turno (forcedClockOutService).
 *
 * The daily operation: a guard finishes their turno but never presses "cerrar
 * turno" in the worker app, leaving an OPEN guardShift (isOnDuty stuck, client
 * coverage keeps painting them "presente" for days). The sweeper force-closes
 * such shifts, flags `forcedClockOut`, appends an explanatory note, drops the
 * on-duty flag, and notifies the guard (FCM) + the tenant's admins (CRM event).
 *
 * Covered against a Sequelize-shaped in-memory fake db (no MySQL, no network),
 * exercising the REAL runForcedShiftEndClockOut with sinon-stubbed side effects:
 *   - candidate SELECTION obeys BOTH branches: scheduledEnd past the grace, AND
 *     the no-scheduledEnd backstop (abandoned ad-hoc/seeded punches older than
 *     MAX_OPEN_HOURS). Recent open shifts are NOT swept.
 *   - the forced close persists punchOutTime + forcedClockOut=true + the note.
 *   - observations TRUNCATION: appending the note to an already-long note never
 *     blows past the 500-char TEXT limit (the bug that made the sweeper retry
 *     the same row forever).
 *   - the guard's isOnDuty flag is flipped off.
 *   - guard FCM push + CRM platform event fire (correct eventType).
 *   - cluster-safe claim: when the conditional UPDATE loses the race (0 rows),
 *     the worker skips — no push, no event, no double close.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-asistencia-faltas/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import { runForcedShiftEndClockOut } from '../../../src/services/forcedClockOutService';

// Stub the external side effects on the SAME cached module objects the service
// imported (CommonJS interop: the service reads `.pushToUser` at call time).
const pushService = require('../../../src/services/pushService');
const platformEventStore = require('../../../src/lib/platformEventStore');
const attendanceService = require('../../../src/services/attendanceService');

const Op = Sequelize.Op;
const TENANT = 'tenant-A';
const FORCED_NOTE_FRAGMENT = 'no cerró el turno';
const OBS_MAX = 500;

// ──────────────────────── Sequelize-shaped fake db ──────────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    __updates: [] as any[],
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (k.startsWith('__') || typeof row[k] === 'function') continue;
        plain[k] = row[k];
      }
      return opts && opts.plain ? plain : plain;
    },
    async update(patch: any) {
      row.__updates.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
      return row;
    },
  };
  return row;
}

function matchField(val: any, cond: any): boolean {
  if (cond === null) return val === null || val === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    for (const s of Object.getOwnPropertySymbols(cond)) {
      if (s === Op.ne) {
        if (cond[s] === null) { if (val === null || val === undefined) return false; }
        else if (val === cond[s]) return false;
      } else if (s === Op.lte) {
        if (!(new Date(val).getTime() <= new Date(cond[s]).getTime())) return false;
      } else if (s === Op.gte) {
        if (!(new Date(val).getTime() >= new Date(cond[s]).getTime())) return false;
      } else if (s === Op.lt) {
        if (!(new Date(val).getTime() < new Date(cond[s]).getTime())) return false;
      } else if (s === Op.in) {
        if (!cond[s].includes(val)) return false;
      }
    }
    return true;
  }
  return val === cond;
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const s of Object.getOwnPropertySymbols(where)) {
    if (s === Op.or) {
      if (!(where[s] as any[]).some((sub) => matchWhere(row, sub))) return false;
    } else if (s === Op.and) {
      if (!(where[s] as any[]).every((sub) => matchWhere(row, sub))) return false;
    }
  }
  for (const [k, v] of Object.entries(where)) {
    if (!matchField(row[k], v)) return false;
  }
  return true;
}

function buildDb(seed: { guardShifts?: any[]; guards?: any[]; stations?: any[] } = {}) {
  const guardShifts = (seed.guardShifts || []).map(makeRow);
  const guards = (seed.guards || []).map(makeRow);
  const stations = (seed.stations || []).map(makeRow);
  const db: any = {
    Sequelize,
    __claimCalls: [] as any[],
    __findAllWhere: null as any,
    settings: { async findByPk() { return null; } },
    guardShift: {
      async findAll({ where, limit }: any) {
        db.__findAllWhere = where;
        let rows = guardShifts.filter((r) => matchWhere(r, where));
        if (limit) rows = rows.slice(0, limit);
        return rows;
      },
      async update(patch: any, opts: any) {
        db.__claimCalls.push({ patch, where: opts && opts.where });
        const rows = guardShifts.filter((r) => matchWhere(r, opts.where));
        for (const r of rows) { r.__updates.push({ ...patch }); for (const [k, v] of Object.entries(patch)) r[k] = v; }
        return [rows.length];
      },
      async findByPk(id: any) { return guardShifts.find((r) => r.id === id) || null; },
    },
    securityGuard: { async findByPk(id: any) { return guards.find((r) => r.id === id) || null; } },
    station: { async findByPk(id: any) { return stations.find((r) => r.id === id) || null; } },
  };
  return { db, guardShifts, guards, stations };
}

describe('op-asistencia-faltas · salida forzada por fin de turno', () => {
  let pushStub: sinon.SinonStub;
  let eventStub: sinon.SinonStub;
  let applyClockOutStub: sinon.SinonStub;

  beforeEach(() => {
    pushStub = sinon.stub(pushService, 'pushToUser').resolves();
    eventStub = sinon.stub(platformEventStore, 'storePlatformEvent').resolves();
    // applyClockOut is best-effort inside the sweeper; stub it so the test does
    // not depend on the full hours/metrics pipeline (covered elsewhere).
    applyClockOutStub = sinon.stub(attendanceService, 'applyClockOut').resolves({ hoursWorked: 8, status: 'on_time' });
  });
  afterEach(() => sinon.restore());

  it('force-closes an overdue shift: punchOutTime + forcedClockOut + note, and drops isOnDuty', async () => {
    const now = Date.now();
    const { db, guardShifts, guards } = buildDb({
      guardShifts: [{
        id: 'gs-1', tenantId: TENANT, guardNameId: 'g-1', stationNameId: 'st-1',
        scheduledEnd: new Date(now - 60 * 60000), // ended 1h ago (past 15-min grace)
        punchInTime: new Date(now - 8 * 3600000), punchOutTime: null, deletedAt: null,
        observations: 'Todo tranquilo en el turno.', sessions: [{ in: new Date(now - 8 * 3600000).toISOString() }],
      }],
      guards: [{ id: 'g-1', guardId: 'u-guard-1', fullName: 'Juan Pérez', isOnDuty: true }],
      stations: [{ id: 'st-1', stationName: 'Puesto Centro' }],
    });

    await runForcedShiftEndClockOut(db);

    const gs = guardShifts[0];
    assert.ok(gs.punchOutTime instanceof Date, 'punchOutTime must be set to close the shift');
    assert.strictEqual(gs.forcedClockOut, true, 'forcedClockOut flag must be raised');
    assert.ok(String(gs.observations).includes(FORCED_NOTE_FRAGMENT), 'the explanatory note must be appended');
    assert.ok(String(gs.observations).includes('Todo tranquilo'), 'the original observation is preserved');
    assert.strictEqual(guards[0].isOnDuty, false, 'the guard on-duty flag must be flipped off');

    assert.strictEqual(pushStub.callCount, 1, 'the guard should get one FCM push');
    assert.strictEqual(pushStub.firstCall.args[2], 'u-guard-1', 'push targets the guard USER id (guardId)');
    assert.strictEqual(pushStub.firstCall.args[3].data.type, 'guard.forced_clockout');
    assert.strictEqual(eventStub.callCount, 1, 'one CRM platform event should be stored');
    assert.strictEqual(eventStub.firstCall.args[1].eventType, 'guard.forced_clockout');
  });

  it('SELECTS the no-scheduledEnd backstop (abandoned punch) but NOT a recent open shift', async () => {
    const now = Date.now();
    const { db, guardShifts } = buildDb({
      guardShifts: [
        // (a) overdue by scheduledEnd → swept
        { id: 'a', tenantId: TENANT, guardNameId: 'g', scheduledEnd: new Date(now - 60 * 60000), punchInTime: new Date(now - 9 * 3600000), punchOutTime: null, deletedAt: null },
        // (b) NO scheduledEnd, punched in 40h ago (> MAX_OPEN_HOURS=30) → backstop sweeps it
        { id: 'b', tenantId: TENANT, guardNameId: 'g', scheduledEnd: null, punchInTime: new Date(now - 40 * 3600000), punchOutTime: null, deletedAt: null },
        // (c) scheduledEnd only 5 min ago (inside 15-min grace) → NOT swept
        { id: 'c', tenantId: TENANT, guardNameId: 'g', scheduledEnd: new Date(now - 5 * 60000), punchInTime: new Date(now - 8 * 3600000), punchOutTime: null, deletedAt: null },
        // (d) NO scheduledEnd, punched in only 2h ago (< 30h) → NOT swept
        { id: 'd', tenantId: TENANT, guardNameId: 'g', scheduledEnd: null, punchInTime: new Date(now - 2 * 3600000), punchOutTime: null, deletedAt: null },
      ],
      guards: [{ id: 'g', guardId: 'u', fullName: 'G', isOnDuty: true }],
    });

    await runForcedShiftEndClockOut(db);

    const byId = (id: string) => guardShifts.find((r) => r.id === id);
    assert.ok(byId('a').punchOutTime, '(a) overdue-by-schedule must be closed');
    assert.ok(byId('b').punchOutTime, '(b) abandoned no-scheduledEnd punch must be closed by the backstop');
    assert.strictEqual(byId('c').punchOutTime, null, '(c) shift still within grace must be left open');
    assert.strictEqual(byId('d').punchOutTime, null, '(d) recent no-scheduledEnd punch must be left open');

    // The WHERE that produced the candidates carries BOTH branches.
    const or = db.__findAllWhere[Op.or];
    assert.ok(Array.isArray(or) && or.length === 2, 'candidate query must OR the schedule branch with the no-scheduledEnd backstop');
  });

  it('TRUNCATES observations to 500 chars when appending the note to an already-long note', async () => {
    const now = Date.now();
    const longObs = 'x'.repeat(600); // already over the limit on its own
    const { db, guardShifts } = buildDb({
      guardShifts: [{ id: 'gs', tenantId: TENANT, guardNameId: 'g', scheduledEnd: new Date(now - 60 * 60000), punchInTime: new Date(now - 8 * 3600000), punchOutTime: null, deletedAt: null, observations: longObs }],
      guards: [{ id: 'g', guardId: 'u', fullName: 'G', isOnDuty: true }],
    });

    await runForcedShiftEndClockOut(db);

    const obs = String(guardShifts[0].observations);
    assert.strictEqual(obs.length, OBS_MAX, `observations must be truncated to exactly ${OBS_MAX} chars, got ${obs.length}`);
    assert.ok(obs.includes(FORCED_NOTE_FRAGMENT), 'the note (which explains the close) must survive the truncation');
    assert.ok(obs.includes('…'), 'the older text is what gets trimmed (ellipsis marker present)');
  });

  it('cluster claim LOST (conditional UPDATE hits 0 rows) → skip: no close side effects, no push, no event', async () => {
    const now = Date.now();
    const { db, guards } = buildDb({
      guardShifts: [{ id: 'gs', tenantId: TENANT, guardNameId: 'g', scheduledEnd: new Date(now - 60 * 60000), punchInTime: new Date(now - 8 * 3600000), punchOutTime: null, deletedAt: null }],
      guards: [{ id: 'g', guardId: 'u', fullName: 'G', isOnDuty: true }],
    });
    // Simulate another PM2 worker having already claimed the row.
    db.guardShift.update = async () => [0];

    await runForcedShiftEndClockOut(db);

    assert.strictEqual(pushStub.callCount, 0, 'no push when the claim was lost');
    assert.strictEqual(eventStub.callCount, 0, 'no CRM event when the claim was lost');
    assert.strictEqual(guards[0].isOnDuty, true, 'on-duty flag untouched when another worker owns the close');
  });

  it('no candidates → does nothing (no push, no event, no throw)', async () => {
    const { db } = buildDb({ guardShifts: [] });
    await runForcedShiftEndClockOut(db);
    assert.strictEqual(pushStub.callCount, 0);
    assert.strictEqual(eventStub.callCount, 0);
  });
});
