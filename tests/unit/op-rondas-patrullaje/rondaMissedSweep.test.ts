/**
 * Unit tests — missed/overdue ronda sweep (runRondaMissedSweep).
 *
 * Config › Rondas › "Notificar rondas perdidas/tarde". The scheduler runs this
 * every 5 min. Two detections, both deduped on tourAssignments.missedNotifiedAt:
 *   A) STARTED but not completed within maxDurationMinutes + graceMinutes.
 *   B) NEVER started while the assigned guard is ON DUTY and their shift began
 *      more than frequencyMinutes + graceMinutes ago.
 *
 * These exercise the REAL src/services/rondaMissedService.ts against an
 * in-memory fake db (no MySQL, no network). notifyPatrol is the side channel
 * (push/email) — stubbed so we assert WHICH rounds are flagged, that the
 * dedup stamp is written, and that the rondaSettings gates (active / notify
 * flags / thresholds) are honoured server-side. NOT covered elsewhere.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rondas-patrullaje/rondaMissedSweep.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import { Op } from 'sequelize';

import { runRondaMissedSweep } from '../../../src/services/rondaMissedService';

const TENANT = 'tenant-A';
const MIN = 60_000;

function makeRow(data: any) {
  const row: any = {
    ...data,
    __updates: [] as any[],
    get(opts?: any) { return opts && opts.plain ? { ...data } : row; },
    async update(patch: any) { row.__updates.push({ ...patch }); Object.assign(row, patch); return row; },
  };
  return row;
}

/** Minimal Op-aware where matcher for the sweep's queries. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    const cond = (where as any)[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const s of Object.getOwnPropertySymbols(cond)) {
        const v = (cond as any)[s];
        if (s === Op.ne && row[key] === v) return false;
        if (s === Op.gt && !(row[key] != null && new Date(row[key]).getTime() > new Date(v).getTime())) return false;
        if (s === Op.lt && !(row[key] != null && new Date(row[key]).getTime() < new Date(v).getTime())) return false;
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function buildDb(seed: {
  assignments?: any[];
  tours?: any[];
  rondaSettings?: any[];
  shifts?: any[];
  tags?: any[];
  scans?: any[];
} = {}) {
  const assignments = (seed.assignments || []).map(makeRow);
  const tours = (seed.tours || []).map(makeRow);
  const settings = (seed.rondaSettings || []).map(makeRow);
  const shifts = (seed.shifts || []).map(makeRow);
  const tags = seed.tags || [];
  const scans = seed.scans || [];

  return {
    tourAssignment: {
      async findAll({ where }: any) { return assignments.filter((r) => matchWhere(r, where)); },
    },
    siteTour: {
      async findByPk(id: string) { return tours.find((t) => t.id === id) || null; },
    },
    rondaSettings: {
      async findOne({ where }: any) {
        return settings.find((s) =>
          s.tenantId === where.tenantId &&
          (where.postSiteId === undefined || s.postSiteId === where.postSiteId)) || null;
      },
    },
    guardShift: {
      async findOne({ where }: any) {
        return shifts.find((s) => matchWhere(s, where)) || null;
      },
    },
    securityGuard: { async findByPk(id: string) { return makeRow({ id, fullName: 'Guardia Uno' }); } },
    siteTourTag: { async count({ where }: any) { return tags.filter((t) => t.siteTourId === where.siteTourId).length; } },
    tagScan: {
      async count({ where, distinct, col }: any) {
        const rows = scans.filter((s) => s.tourAssignmentId === where.tourAssignmentId);
        if (distinct && col) return new Set(rows.map((r) => r[col])).size;
        return rows.length;
      },
    },
    __assignments: assignments,
  } as any;
}

const settingsRow = (over: any = {}) => ({
  tenantId: TENANT, postSiteId: null, active: true,
  notifyTenantOnMissed: true, frequencyMinutes: 60, graceMinutes: 5,
  maxDurationMinutes: 45, requirePhoto: false, requireNote: false, requireGeofence: false,
  ...over,
});

describe('op-rondas · missed-ronda sweep', () => {
  let notifyStub: sinon.SinonStub;
  beforeEach(() => {
    const rondaNotify = require('../../../src/services/rondaNotify');
    notifyStub = sinon.stub(rondaNotify, 'notifyPatrol').resolves();
  });
  afterEach(() => sinon.restore());

  // ── Leg A: started but overdue ────────────────────────────────────────────
  it('flags a started round overdue past maxDuration+grace and stamps missedNotifiedAt', async () => {
    const now = Date.now();
    const db = buildDb({
      // started 60 min ago; allowed = 45+5 = 50 min → overdue.
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: new Date(now - 60 * MIN), missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'Ronda Norte', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
      tags: [{ siteTourId: 'tour-1' }, { siteTourId: 'tour-1' }],
      scans: [{ tourAssignmentId: 'asg-1', siteTourTagId: 'tag-1' }],
    });

    await runRondaMissedSweep(db);

    assert.ok(notifyStub.calledOnce, 'overdue round → one missed notify');
    const arg = notifyStub.firstCall.args[1];
    assert.strictEqual(arg.event, 'missed');
    assert.strictEqual(arg.routeName, 'Ronda Norte');
    assert.strictEqual(arg.detail, 'incompleta: 1 de 2 puntos', 'progress snapshot from real scans');
    assert.ok(db.__assignments[0].__updates.some((u: any) => u.missedNotifiedAt instanceof Date), 'dedup stamp written');
  });

  it('does NOT flag a started round still WITHIN maxDuration+grace', async () => {
    const now = Date.now();
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: new Date(now - 20 * MIN), missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'round still within its window → no alert');
  });

  it('dedups — an already-notified overdue round is not re-alerted (missedNotifiedAt >= startAt)', async () => {
    const now = Date.now();
    const startAt = new Date(now - 90 * MIN);
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt, missedNotifiedAt: new Date(now - 30 * MIN) }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'already alerted for this run → no duplicate');
  });

  it('honours notifyTenantOnMissed=false (feature off → never alerts)', async () => {
    const now = Date.now();
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: new Date(now - 120 * MIN), missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1', notifyTenantOnMissed: false })],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'notify disabled → silent');
  });

  it('honours active=false (ronda config disabled → never alerts)', async () => {
    const now = Date.now();
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: new Date(now - 120 * MIN), missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1', active: false })],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'config inactive → silent');
  });

  // ── Leg B: never started while guard is on duty ───────────────────────────
  it('flags a never-started round when the guard is on duty past frequency+grace', async () => {
    const now = Date.now();
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: null, securityGuardId: 'sg-1', missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'Ronda Sur', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
      // shift started 90 min ago; due = 60+5 = 65 → overdue.
      shifts: [{ id: 'sh-1', tenantId: TENANT, guardNameId: 'sg-1', punchOutTime: null, punchInTime: new Date(now - 90 * MIN) }],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.calledOnce, 'unstarted overdue round → alert');
    const arg = notifyStub.firstCall.args[1];
    assert.strictEqual(arg.detail, 'no se ha realizado en el turno actual');
  });

  it('does NOT flag an unstarted round when the guard is NOT on duty (no open shift)', async () => {
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: null, securityGuardId: 'sg-1', missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
      shifts: [], // guard is off duty
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'off-duty guard → the round is simply not scheduled yet');
  });

  it('does NOT flag an unstarted round when the shift began less than frequency+grace ago', async () => {
    const now = Date.now();
    const db = buildDb({
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, startAt: null, securityGuardId: 'sg-1', missedNotifiedAt: null }],
      tours: [{ id: 'tour-1', name: 'R', postSiteId: 'ps-1' }],
      rondaSettings: [settingsRow({ postSiteId: 'ps-1' })],
      shifts: [{ id: 'sh-1', tenantId: TENANT, guardNameId: 'sg-1', punchOutTime: null, punchInTime: new Date(now - 30 * MIN) }],
    });
    await runRondaMissedSweep(db);
    assert.ok(notifyStub.notCalled, 'not yet due within the current shift');
  });

  it('no-op when the db has no tourAssignment model (defensive early return)', async () => {
    await runRondaMissedSweep({} as any);
    assert.ok(notifyStub.notCalled);
  });
});
