/**
 * Unit tests — Salida forzada de supervisor (supervisorForcedClockOutService).
 *
 * The supervisor mirror of the guard sweeper, but over `supervisorShift`: closes
 * any open supervisor punch whose scheduled turno ended more than the grace
 * window ago, so a supervisor can't stay "on the clock" indefinitely past their
 * turno. Clears the denormalized supervisorProfile.isOnDuty and drops a CRM
 * event. Cluster-safe via a conditional UPDATE on punchOutTime IS NULL.
 *
 * REAL runSupervisorForcedClockOut against a Sequelize-shaped in-memory fake db.
 *
 * Covered:
 *   - a stale open shift is closed: punchOutTime + forcedClockOut=true + the
 *     auto-close note appended to any existing observations.
 *   - the note is set (not undefined) when there were no prior observations.
 *   - supervisorProfile.isOnDuty is cleared for that supervisor.
 *   - a shift with NO scheduledEnd is left alone (this sweeper has no backstop).
 *   - a shift still within the grace window is left open.
 *   - cluster claim lost (UPDATE → 0 rows) → the profile flag is left untouched.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-asistencia-faltas/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import { runSupervisorForcedClockOut } from '../../../src/services/supervisorForcedClockOutService';

const platformEventStore = require('../../../src/lib/platformEventStore');

const Op = Sequelize.Op;
const TENANT = 'tenant-A';

function makeRow(data: any) {
  const row: any = {
    ...data,
    async update(patch: any) { for (const [k, v] of Object.entries(patch)) row[k] = v; return row; },
  };
  return row;
}

function matchWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where || {})) {
    if (v === null) { if (!(row[k] === null || row[k] === undefined)) return false; continue; }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      for (const s of Object.getOwnPropertySymbols(v as any)) {
        if (s === Op.ne) { if ((v as any)[s] === null) { if (row[k] === null || row[k] === undefined) return false; } }
        else if (s === Op.lte) { if (!(new Date(row[k]).getTime() <= new Date((v as any)[s]).getTime())) return false; }
      }
    } else if (row[k] !== v) return false;
  }
  return true;
}

function buildDb(seed: { shifts?: any[]; profiles?: any[] } = {}) {
  const supShifts = (seed.shifts || []).map(makeRow);
  const profiles = (seed.profiles || []).map(makeRow);
  const db: any = {
    Sequelize,
    __claim: null as any,
    supervisorShift: {
      async findAll({ where }: any) { return supShifts.filter((r) => matchWhere(r, where)); },
      async update(patch: any, opts: any) {
        const rows = supShifts.filter((r) => matchWhere(r, opts.where));
        for (const r of rows) for (const [k, v] of Object.entries(patch)) r[k] = v;
        return [rows.length];
      },
    },
    supervisorProfile: {
      async update(patch: any, opts: any) {
        const rows = profiles.filter((p) => p.tenantId === opts.where.tenantId && p.supervisorUserId === opts.where.supervisorUserId);
        for (const p of rows) for (const [k, v] of Object.entries(patch)) p[k] = v;
        return [rows.length];
      },
    },
  };
  return { db, supShifts, profiles };
}

describe('op-asistencia-faltas · salida forzada de supervisor', () => {
  let eventStub: sinon.SinonStub;
  beforeEach(() => { eventStub = sinon.stub(platformEventStore, 'storePlatformEvent').resolves(); });
  afterEach(() => sinon.restore());

  it('closes a stale supervisor shift and clears the profile on-duty flag', async () => {
    const now = Date.now();
    const { db, supShifts, profiles } = buildDb({
      shifts: [{ id: 'ss-1', tenantId: TENANT, supervisorUserId: 'sup-1', punchOutTime: null, deletedAt: null, scheduledEnd: new Date(now - 60 * 60000), observations: 'Ronda nocturna sin novedad' }],
      profiles: [{ tenantId: TENANT, supervisorUserId: 'sup-1', isOnDuty: true }],
    });

    await runSupervisorForcedClockOut(db);

    const ss = supShifts[0];
    assert.ok(ss.punchOutTime instanceof Date, 'punchOutTime must be set');
    assert.strictEqual(ss.forcedClockOut, true);
    assert.ok(String(ss.observations).includes('Ronda nocturna sin novedad'), 'existing observations preserved');
    assert.ok(String(ss.observations).includes('Cierre automático'), 'auto-close note appended');
    assert.strictEqual(profiles[0].isOnDuty, false, 'supervisor profile on-duty flag cleared');
    assert.strictEqual(eventStub.callCount, 1);
    assert.strictEqual(eventStub.firstCall.args[1].eventType, 'supervisor.forced_checkout');
  });

  it('sets the note even when there were no prior observations', async () => {
    const now = Date.now();
    const { db, supShifts } = buildDb({
      shifts: [{ id: 'ss', tenantId: TENANT, supervisorUserId: 's', punchOutTime: null, deletedAt: null, scheduledEnd: new Date(now - 60 * 60000), observations: null }],
      profiles: [{ tenantId: TENANT, supervisorUserId: 's', isOnDuty: true }],
    });
    await runSupervisorForcedClockOut(db);
    assert.strictEqual(supShifts[0].observations, 'Cierre automático al fin del turno');
  });

  it('leaves a shift with NO scheduledEnd open (this sweeper has no backstop)', async () => {
    const { db, supShifts } = buildDb({
      shifts: [{ id: 'ss', tenantId: TENANT, supervisorUserId: 's', punchOutTime: null, deletedAt: null, scheduledEnd: null }],
      profiles: [{ tenantId: TENANT, supervisorUserId: 's', isOnDuty: true }],
    });
    await runSupervisorForcedClockOut(db);
    assert.strictEqual(supShifts[0].punchOutTime, null, 'null scheduledEnd → never swept');
    assert.strictEqual(eventStub.callCount, 0);
  });

  it('leaves a shift still within the grace window open', async () => {
    const now = Date.now();
    // Default grace is 30 min; ended 5 min ago → still within grace.
    const { db, supShifts } = buildDb({
      shifts: [{ id: 'ss', tenantId: TENANT, supervisorUserId: 's', punchOutTime: null, deletedAt: null, scheduledEnd: new Date(now - 5 * 60000) }],
      profiles: [{ tenantId: TENANT, supervisorUserId: 's', isOnDuty: true }],
    });
    await runSupervisorForcedClockOut(db);
    assert.strictEqual(supShifts[0].punchOutTime, null, 'within grace → left open');
  });

  it('cluster claim lost (UPDATE → 0 rows) → profile flag untouched, no event', async () => {
    const now = Date.now();
    const { db, profiles } = buildDb({
      shifts: [{ id: 'ss', tenantId: TENANT, supervisorUserId: 's', punchOutTime: null, deletedAt: null, scheduledEnd: new Date(now - 60 * 60000) }],
      profiles: [{ tenantId: TENANT, supervisorUserId: 's', isOnDuty: true }],
    });
    db.supervisorShift.update = async () => [0];
    await runSupervisorForcedClockOut(db);
    assert.strictEqual(profiles[0].isOnDuty, true, 'another worker owns the close → we do not touch the flag');
    assert.strictEqual(eventStub.callCount, 0);
  });
});
