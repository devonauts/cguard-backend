/**
 * Unit tests — Permiso/ausencia aprobada AFECTA EL TURNO (scheduleAbsenceService).
 *
 * Approving a Time-Off request must reach the LIVE schedule, not just flip the
 * request's status: otherwise the Horario keeps painting the guard D/N, client
 * coverage keeps counting them, and the worker app keeps showing the turno
 * (2026-07-18 audit, batch 2). This service mirrors the Programador novedad
 * path: one scheduleOverride per calendar day (V vacaciones · PM permiso) +
 * deletion of the guard's GENERATED shifts on those tenant-calendar days.
 *
 * REAL applyAbsenceOverrides / overrideTypeForTimeOff against a Sequelize-shaped
 * in-memory fake db (no MySQL, no network).
 *
 * Covered:
 *   - overrideTypeForTimeOff: vacaciones → V, everything else → PM.
 *   - one override upserted per day across a multi-day range (inclusive).
 *   - an EXISTING override of a different type is corrected (record.update).
 *   - generated shifts inside the range are removed; the count is returned.
 *   - shift-day attribution honors the TENANT timezone (a UTC punch that is a
 *     different local calendar day is judged in local time).
 *   - guard clauses: missing guard/startDate, reversed/invalid range → no-op.
 *   - MAX_RANGE_DAYS cap so a pathological range can't walk forever.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-asistencia-faltas/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import Sequelize from 'sequelize';

import {
  applyAbsenceOverrides,
  overrideTypeForTimeOff,
} from '../../../src/services/scheduleAbsenceService';

const Op = Sequelize.Op;
const TENANT = 'tenant-A';
const GUARD = 'user-guard-1';

// ── Sequelize-shaped fake db for the two models the service touches. ─────────
function makeShiftRow(data: any) {
  return { ...data, get(o?: any) { return o && o.plain ? { ...data } : data; } };
}

function buildDb(opts: { tenantTz?: string; shifts?: any[] } = {}) {
  const overrides: any[] = []; // scheduleOverride store
  const overrideUpdates: any[] = [];
  let shifts = (opts.shifts || []).map(makeShiftRow);
  const destroyed: any[] = [];

  const db: any = {
    Sequelize,
    scheduleOverride: {
      async findOrCreate({ where, defaults }: any) {
        let row = overrides.find(
          (o) => o.guardId === where.guardId && o.date === where.date && o.tenantId === where.tenantId,
        );
        if (row) return [row, false];
        row = {
          ...defaults,
          async update(patch: any) { overrideUpdates.push({ id: this.date, patch }); Object.assign(this, patch); return this; },
        };
        overrides.push(row);
        return [row, true];
      },
    },
    tenant: {
      async findByPk() { return { timezone: opts.tenantTz || 'UTC' }; },
    },
    shift: {
      async findAll({ where }: any) {
        // Only the tenant + guard + startTime range predicate matters here.
        const from = where.startTime[Op.gte];
        const to = where.startTime[Op.lt];
        return shifts.filter(
          (s) => s.guardId === where.guardId && s.tenantId === where.tenantId &&
            new Date(s.startTime).getTime() >= new Date(from).getTime() &&
            new Date(s.startTime).getTime() < new Date(to).getTime(),
        );
      },
      async destroy({ where }: any) {
        const ids: any[] = Array.isArray(where.id) ? where.id : [where.id];
        const before = shifts.length;
        shifts = shifts.filter((s) => { const hit = ids.includes(s.id) && s.tenantId === where.tenantId; if (hit) destroyed.push(s.id); return !hit; });
        return before - shifts.length;
      },
    },
    __overrides: overrides,
    __overrideUpdates: overrideUpdates,
    __destroyed: destroyed,
    get __shifts() { return shifts; },
  };
  return db;
}

describe('op-asistencia-faltas · permiso aprobado afecta el turno (scheduleAbsence)', () => {
  describe('overrideTypeForTimeOff — novedad code mapping', () => {
    it('maps a vacaciones request to V and everything else to PM', () => {
      assert.strictEqual(overrideTypeForTimeOff('vacaciones'), 'V');
      assert.strictEqual(overrideTypeForTimeOff('Vacation'), 'V');
      assert.strictEqual(overrideTypeForTimeOff('permiso médico'), 'PM');
      assert.strictEqual(overrideTypeForTimeOff('personal'), 'PM');
      assert.strictEqual(overrideTypeForTimeOff(null), 'PM');
      assert.strictEqual(overrideTypeForTimeOff(undefined), 'PM');
    });
  });

  describe('applyAbsenceOverrides — writes one novedad per day + strips generated shifts', () => {
    it('upserts one override per inclusive day and removes the guard shifts on those days', async () => {
      const db = buildDb({
        tenantTz: 'UTC',
        shifts: [
          { id: 'sh-1', guardId: GUARD, tenantId: TENANT, startTime: new Date('2026-08-10T08:00:00Z') },
          { id: 'sh-2', guardId: GUARD, tenantId: TENANT, startTime: new Date('2026-08-11T08:00:00Z') },
          // outside the range — must survive
          { id: 'sh-3', guardId: GUARD, tenantId: TENANT, startTime: new Date('2026-08-15T08:00:00Z') },
        ],
      });

      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '2026-08-10', '2026-08-12', 'V', 'admin-1');

      assert.strictEqual(res.days, 3, '10, 11, 12 = 3 inclusive days');
      assert.strictEqual(res.shiftsRemoved, 2, 'only the two shifts inside the range are removed');
      const dates = db.__overrides.map((o: any) => o.date).sort();
      assert.deepStrictEqual(dates, ['2026-08-10', '2026-08-11', '2026-08-12']);
      assert.ok(db.__overrides.every((o: any) => o.type === 'V' && o.tenantId === TENANT && o.createdById === 'admin-1'));
      assert.deepStrictEqual(db.__destroyed.sort(), ['sh-1', 'sh-2']);
      assert.ok(db.__shifts.some((s: any) => s.id === 'sh-3'), 'the out-of-range shift is untouched');
    });

    it('corrects an EXISTING override whose type differs (does not leave a stale code)', async () => {
      const db = buildDb({ tenantTz: 'UTC' });
      // Pre-seed a PM override for the day; approving a vacaciones must upgrade it to V.
      db.__overrides.push({ guardId: GUARD, date: '2026-08-10', tenantId: TENANT, type: 'PM',
        async update(patch: any) { Object.assign(this, patch); return this; } });

      await applyAbsenceOverrides(db, TENANT, GUARD, '2026-08-10', '2026-08-10', 'V', null);

      const row = db.__overrides.find((o: any) => o.date === '2026-08-10');
      assert.strictEqual(row.type, 'V', 'the existing override type is corrected to the new code');
      assert.strictEqual(db.__overrides.length, 1, 'no duplicate override row is inserted for the same day');
    });

    it('attributes shift removal by TENANT timezone, not raw UTC day', async () => {
      // Punch stored 2026-08-11T02:00:00Z. In America/Guayaquil (UTC-5) that is
      // 2026-08-10 21:00 local → belongs to the 2026-08-10 absence day.
      const db = buildDb({
        tenantTz: 'America/Guayaquil',
        shifts: [{ id: 'sh-late', guardId: GUARD, tenantId: TENANT, startTime: new Date('2026-08-11T02:00:00Z') }],
      });

      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '2026-08-10', '2026-08-10', 'PM', null);

      assert.strictEqual(res.shiftsRemoved, 1, 'the shift is a local-Aug-10 shift and must be removed for the Aug-10 permiso');
      assert.deepStrictEqual(db.__destroyed, ['sh-late']);
    });

    it('single-day request (no endDate) creates exactly one override', async () => {
      const db = buildDb({ tenantTz: 'UTC' });
      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '2026-08-10', null, 'PM', null);
      assert.strictEqual(res.days, 1);
      assert.strictEqual(db.__overrides.length, 1);
      assert.strictEqual(db.__overrides[0].date, '2026-08-10');
    });
  });

  describe('applyAbsenceOverrides — guard clauses', () => {
    it('no guard id → no-op {0,0}', async () => {
      const db = buildDb();
      const res = await applyAbsenceOverrides(db, TENANT, '', '2026-08-10', '2026-08-12', 'V', null);
      assert.deepStrictEqual(res, { days: 0, shiftsRemoved: 0 });
      assert.strictEqual(db.__overrides.length, 0);
    });

    it('no start date → no-op {0,0}', async () => {
      const db = buildDb();
      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '', '2026-08-12', 'V', null);
      assert.deepStrictEqual(res, { days: 0, shiftsRemoved: 0 });
    });

    it('reversed range (end before start) → no-op, no overrides written', async () => {
      const db = buildDb();
      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '2026-08-12', '2026-08-10', 'V', null);
      assert.deepStrictEqual(res, { days: 0, shiftsRemoved: 0 });
      assert.strictEqual(db.__overrides.length, 0);
    });

    it('caps a pathological multi-year range at MAX_RANGE_DAYS (366)', async () => {
      const db = buildDb();
      const res = await applyAbsenceOverrides(db, TENANT, GUARD, '2026-01-01', '2030-01-01', 'V', null);
      assert.strictEqual(res.days, 366, 'the day walk is capped so it can never run away');
    });
  });
});
