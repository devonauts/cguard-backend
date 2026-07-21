/**
 * op-turnos · Absence → live-schedule propagation (novedad L/V/PM de un día).
 *
 * Exercises the REAL applyAbsenceOverrides (src/services/scheduleAbsenceService),
 * the path an APPROVED time-off request runs to keep the Horario honest:
 *   - one scheduleOverride per calendar day in the range (upsert semantics)
 *   - the guard’s generated shifts on those tenant-calendar days are removed
 *   - guards against empty/invalid input (no guard, bad range) — no writes
 *   - overrideTypeForTimeOff maps request types to novedad codes
 */
import assert from 'assert';

import { applyAbsenceOverrides, overrideTypeForTimeOff } from '../../../src/services/scheduleAbsenceService';
import { buildDb, makeRow, TENANT } from './helpers';

describe('op-turnos · overrideTypeForTimeOff', () => {
  it('maps a vacation request to "V"', () => {
    assert.strictEqual(overrideTypeForTimeOff('Vacaciones'), 'V');
    assert.strictEqual(overrideTypeForTimeOff('annual vacation'), 'V');
  });
  it('maps everything else (permiso, sick, etc.) to "PM"', () => {
    assert.strictEqual(overrideTypeForTimeOff('Permiso médico'), 'PM');
    assert.strictEqual(overrideTypeForTimeOff(null), 'PM');
  });
});

describe('op-turnos · applyAbsenceOverrides', () => {
  it('creates ONE override per day across the range and reports the day count', async () => {
    const db = buildDb();
    const res = await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-14', '2026-07-16', 'V', 'admin-1');
    assert.strictEqual(res.days, 3, 'a 3-day range must produce 3 override-days');
    assert.strictEqual(db.scheduleOverride.calls.findOrCreate.length, 3);

    const first = db.scheduleOverride.calls.findOrCreate[0];
    assert.strictEqual(first.where.guardId, 'g-1');
    assert.strictEqual(first.where.date, '2026-07-14');
    assert.strictEqual(first.where.tenantId, TENANT);
    assert.strictEqual(first.defaults.type, 'V');
    assert.strictEqual(first.defaults.createdById, 'admin-1');
    // Distinct days, not the same day thrice.
    assert.deepStrictEqual(
      db.scheduleOverride.calls.findOrCreate.map((c: any) => c.where.date),
      ['2026-07-14', '2026-07-15', '2026-07-16'],
    );
  });

  it('a single-day absence (no end date) produces exactly one override', async () => {
    const db = buildDb();
    const res = await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-14', null, 'PM', null);
    assert.strictEqual(res.days, 1);
    assert.strictEqual(db.scheduleOverride.rows.length, 1);
    assert.strictEqual(db.scheduleOverride.rows[0].date, '2026-07-14');
  });

  it('UPSERTS: an existing override for the same guard+date is re-typed, not duplicated', async () => {
    const db = buildDb({
      scheduleOverride: [
        { id: 'ov-1', tenantId: TENANT, guardId: 'g-1', date: '2026-07-14', type: 'D', deletedAt: null },
      ],
    });
    await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-14', '2026-07-14', 'V', 'admin-1');
    assert.strictEqual(db.scheduleOverride.rows.length, 1, 'must not duplicate the day');
    assert.strictEqual(db.scheduleOverride.rows[0].type, 'V', 'existing override type must be updated to the new absence code');
  });

  it('removes the guard’s generated shifts whose local day falls in the range (UTC tenant)', async () => {
    const db = buildDb({
      shift: [
        makeRow({ id: 'sh-in', tenantId: TENANT, guardId: 'g-1', startTime: new Date('2026-07-14T10:00:00Z'), deletedAt: null }),
        makeRow({ id: 'sh-out', tenantId: TENANT, guardId: 'g-1', startTime: new Date('2026-07-20T10:00:00Z'), deletedAt: null }),
      ],
    });
    const res = await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-14', '2026-07-14', 'V', 'admin-1');
    assert.strictEqual(res.shiftsRemoved, 1, 'the in-range shift must be removed');
    assert.strictEqual(db.shift.rows.find((r: any) => r.id === 'sh-in').__destroyed, true);
    assert.strictEqual(db.shift.rows.find((r: any) => r.id === 'sh-out').__destroyed, false, 'an out-of-range shift must survive');
  });

  it('does not touch ANOTHER guard’s shift on the same day (guard-scoped removal)', async () => {
    const db = buildDb({
      shift: [
        makeRow({ id: 'sh-other', tenantId: TENANT, guardId: 'g-2', startTime: new Date('2026-07-14T10:00:00Z'), deletedAt: null }),
      ],
    });
    const res = await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-14', '2026-07-14', 'V', 'admin-1');
    assert.strictEqual(res.shiftsRemoved, 0);
    assert.strictEqual(db.shift.rows[0].__destroyed, false, 'another guard’s shift must never be removed');
  });

  it('no guard id → a no-op (nothing written)', async () => {
    const db = buildDb();
    const res = await applyAbsenceOverrides(db, TENANT, '', '2026-07-14', '2026-07-16', 'V', null);
    assert.deepStrictEqual(res, { days: 0, shiftsRemoved: 0 });
    assert.strictEqual(db.scheduleOverride.calls.findOrCreate.length, 0);
  });

  it('an inverted range (end before start) → a no-op (nothing written)', async () => {
    const db = buildDb();
    const res = await applyAbsenceOverrides(db, TENANT, 'g-1', '2026-07-16', '2026-07-14', 'V', null);
    assert.deepStrictEqual(res, { days: 0, shiftsRemoved: 0 });
    assert.strictEqual(db.scheduleOverride.calls.findOrCreate.length, 0);
  });
});
