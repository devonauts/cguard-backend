/**
 * Unit tests — schedule / shifts / no-double-booking enforcement.
 *
 * These exercise the REAL functions that protect the core promise "a guard can
 * never be in two places at once, and everybody gets their rest day":
 *
 *   1. findGuardShiftOverlap (shiftOverlap.ts) — the shared no-double-booking
 *      predicate used by EVERY shift-write path. Driven against an in-memory
 *      fake `db.shift` that faithfully evaluates the Sequelize Op.lt/Op.gt/Op.ne
 *      range query the function builds (no MySQL).
 *   2. detectRestWarnings (scheduleValidation.ts) — a PURE function: detects
 *      same-day double-bookings (two stations) and weekly-rest violations
 *      (> N consecutive worked days).
 *   3. The half-open overlap predicate itself (aStart < bEnd && bStart < aEnd),
 *      asserted directly on boundary/adjacency cases so the contract is pinned.
 *
 * No DB, no network. Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/schedule-shifts/overlap.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import { Op } from 'sequelize';

import { findGuardShiftOverlap } from '../../../src/services/shiftOverlap';
import { detectRestWarnings, ValidationShift } from '../../../src/services/scheduleValidation';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ───────────────────────────── Fake db.shift ─────────────────────────────
//
// A tiny model that evaluates exactly the where-clause findGuardShiftOverlap
// builds: equality on tenantId/guardId, Op.lt/Op.gt on the time columns, and an
// optional Op.ne on id (excludeShiftId). Rows are plain objects with Date times.

type ShiftRow = {
  id: string;
  tenantId: string;
  guardId: string | null;
  startTime: Date;
  endTime: Date;
};

function buildShiftDb(rows: ShiftRow[]) {
  const matches = (row: ShiftRow, where: any): boolean => {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
    if (where.guardId !== undefined && row.guardId !== where.guardId) return false;

    // startTime: { [Op.lt]: endTime }
    if (where.startTime && where.startTime[Op.lt] !== undefined) {
      if (!(row.startTime.getTime() < new Date(where.startTime[Op.lt]).getTime())) return false;
    }
    // endTime: { [Op.gt]: startTime }
    if (where.endTime && where.endTime[Op.gt] !== undefined) {
      if (!(row.endTime.getTime() > new Date(where.endTime[Op.gt]).getTime())) return false;
    }
    // id: { [Op.ne]: excludeShiftId }
    if (where.id && where.id[Op.ne] !== undefined) {
      if (row.id === where.id[Op.ne]) return false;
    }
    return true;
  };

  return {
    shift: {
      async findOne({ where }: any) {
        const hit = rows.find((r) => matches(r, where));
        return hit || null;
      },
    },
  };
}

const d = (iso: string) => new Date(iso);

// ─────────────────────────── findGuardShiftOverlap ────────────────────────────

describe('schedule-shifts — findGuardShiftOverlap (shared no-double-booking predicate)', () => {
  it('returns the conflicting shift when two ranges overlap', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
    ]);
    // New shift 12:00–20:00 overlaps the existing 06:00–18:00.
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T12:00:00Z'), d('2026-07-01T20:00:00Z'));
    assert.ok(conflict, 'expected an overlap');
    assert.strictEqual(conflict.id, 's1');
  });

  it('treats touching ranges as NON-overlapping (half-open [start,end))', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
    ]);
    // New shift starts exactly when the old one ends → back-to-back, allowed.
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T18:00:00Z'), d('2026-07-02T06:00:00Z'));
    assert.strictEqual(conflict, null, 'adjacent shifts must not be flagged as overlap');
  });

  it('treats a shift ending exactly at the new start as NON-overlapping (other boundary)', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T18:00:00Z'), endTime: d('2026-07-02T06:00:00Z') },
    ]);
    // New shift 06:00–18:00 ends exactly when the existing one starts.
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T06:00:00Z'), d('2026-07-01T18:00:00Z'));
    assert.strictEqual(conflict, null);
  });

  it('flags a fully-contained shift (new range inside an existing one)', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T00:00:00Z'), endTime: d('2026-07-02T00:00:00Z') },
    ]);
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T10:00:00Z'), d('2026-07-01T14:00:00Z'));
    assert.ok(conflict && conflict.id === 's1');
  });

  it('does NOT flag a different guard (guardId scoping)', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
    ]);
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g2', d('2026-07-01T08:00:00Z'), d('2026-07-01T16:00:00Z'));
    assert.strictEqual(conflict, null, 'overlap must be scoped per guard');
  });

  it('does NOT flag a shift in another tenant (tenant scoping)', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_B, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
    ]);
    const conflict = await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T08:00:00Z'), d('2026-07-01T16:00:00Z'));
    assert.strictEqual(conflict, null, 'overlap must be scoped per tenant');
  });

  it('excludes the record being edited via excludeShiftId (update path)', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
    ]);
    // Editing s1 itself must not self-conflict.
    const conflict = await findGuardShiftOverlap(
      db, TENANT_A, 'g1', d('2026-07-01T06:00:00Z'), d('2026-07-01T18:00:00Z'),
      { excludeShiftId: 's1' },
    );
    assert.strictEqual(conflict, null, 'a shift must not conflict with itself on update');
  });

  it('still catches a DIFFERENT overlapping shift even when excludeShiftId is set', async () => {
    const db = buildShiftDb([
      { id: 's1', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T06:00:00Z'), endTime: d('2026-07-01T18:00:00Z') },
      { id: 's2', tenantId: TENANT_A, guardId: 'g1', startTime: d('2026-07-01T12:00:00Z'), endTime: d('2026-07-01T22:00:00Z') },
    ]);
    const conflict = await findGuardShiftOverlap(
      db, TENANT_A, 'g1', d('2026-07-01T06:00:00Z'), d('2026-07-01T18:00:00Z'),
      { excludeShiftId: 's1' },
    );
    assert.ok(conflict && conflict.id === 's2', 'a real overlap from another row must still be caught');
  });

  it('short-circuits to null on missing guardId / start / end (no query)', async () => {
    let called = false;
    const db = { shift: { async findOne() { called = true; return { id: 'x' }; } } };
    assert.strictEqual(await findGuardShiftOverlap(db, TENANT_A, null, d('2026-07-01T06:00:00Z'), d('2026-07-01T18:00:00Z')), null);
    assert.strictEqual(await findGuardShiftOverlap(db, TENANT_A, 'g1', null, d('2026-07-01T18:00:00Z')), null);
    assert.strictEqual(await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T06:00:00Z'), null), null);
    assert.strictEqual(called, false, 'must not hit the DB when inputs are incomplete');
  });

  it('passes the transaction through to findOne', async () => {
    let seenTx: any;
    const db = {
      shift: {
        async findOne({ transaction }: any) { seenTx = transaction; return null; },
      },
    };
    const tx = { id: 'TX-1' };
    await findGuardShiftOverlap(db, TENANT_A, 'g1', d('2026-07-01T06:00:00Z'), d('2026-07-01T18:00:00Z'), { transaction: tx });
    assert.strictEqual(seenTx, tx, 'overlap check must run inside the caller transaction');
  });
});

// ───────────── half-open overlap predicate (contract pinned directly) ─────────

describe('schedule-shifts — half-open overlap predicate', () => {
  // The contract used everywhere: ranges [aStart,aEnd) and [bStart,bEnd) overlap
  // iff aStart < bEnd && bStart < aEnd.
  const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

  it('overlaps for intersecting ranges', () => {
    assert.strictEqual(overlaps(0, 10, 5, 15), true);
    assert.strictEqual(overlaps(5, 15, 0, 10), true);
  });
  it('does not overlap for adjacent (touching) ranges', () => {
    assert.strictEqual(overlaps(0, 10, 10, 20), false);
    assert.strictEqual(overlaps(10, 20, 0, 10), false);
  });
  it('does not overlap for fully-disjoint ranges', () => {
    assert.strictEqual(overlaps(0, 10, 20, 30), false);
  });
  it('overlaps for a fully-contained range', () => {
    assert.strictEqual(overlaps(0, 100, 40, 60), true);
    assert.strictEqual(overlaps(40, 60, 0, 100), true);
  });
});

// ─────────────────────────── detectRestWarnings (pure) ────────────────────────

describe('schedule-shifts — detectRestWarnings (rest-rule + double-booking)', () => {
  const at = (day: string, station: string, guard = 'g1'): ValidationShift => ({
    guardId: guard,
    stationId: station,
    startTime: `${day}T08:00:00Z`,
  });

  it('flags a same-day double-booking (two different stations one day)', () => {
    const w = detectRestWarnings([
      at('2026-07-01', 'stA'),
      at('2026-07-01', 'stB'), // same guard, same day, DIFFERENT station
    ]);
    assert.strictEqual(w.doubleBookings.length, 1);
    assert.strictEqual(w.doubleBookings[0].guardId, 'g1');
    assert.strictEqual(w.doubleBookings[0].days, 1);
    assert.strictEqual(w.restViolations.length, 0);
  });

  it('does NOT flag two shifts at the SAME station on the same day', () => {
    const w = detectRestWarnings([
      at('2026-07-01', 'stA'),
      at('2026-07-01', 'stA'), // same station → split shift, not a double-booking
    ]);
    assert.strictEqual(w.doubleBookings.length, 0);
  });

  it('counts multiple double-booked days for one guard', () => {
    const w = detectRestWarnings([
      at('2026-07-01', 'stA'), at('2026-07-01', 'stB'),
      at('2026-07-03', 'stA'), at('2026-07-03', 'stC'),
    ]);
    assert.strictEqual(w.doubleBookings.length, 1);
    assert.strictEqual(w.doubleBookings[0].days, 2);
  });

  it('flags a weekly-rest violation when consecutive days exceed maxConsecutive', () => {
    // 8 consecutive days, default max = 7 → violation with maxConsecutive 8.
    const shifts: ValidationShift[] = [];
    for (let i = 1; i <= 8; i++) {
      shifts.push(at(`2026-07-0${i}`, 'stA'));
    }
    const w = detectRestWarnings(shifts);
    assert.strictEqual(w.restViolations.length, 1);
    assert.strictEqual(w.restViolations[0].guardId, 'g1');
    assert.strictEqual(w.restViolations[0].maxConsecutive, 8);
  });

  it('does NOT flag exactly maxConsecutive consecutive days (boundary)', () => {
    const shifts: ValidationShift[] = [];
    for (let i = 1; i <= 7; i++) shifts.push(at(`2026-07-0${i}`, 'stA'));
    const w = detectRestWarnings(shifts, 7);
    assert.strictEqual(w.restViolations.length, 0, '7 days with max 7 is allowed');
  });

  it('resets the consecutive run after a rest day (gap)', () => {
    // 5 days, rest, 5 days → longest run is 5, under the default 7.
    const shifts = [
      at('2026-07-01', 'stA'), at('2026-07-02', 'stA'), at('2026-07-03', 'stA'),
      at('2026-07-04', 'stA'), at('2026-07-05', 'stA'),
      // 2026-07-06 OFF
      at('2026-07-07', 'stA'), at('2026-07-08', 'stA'), at('2026-07-09', 'stA'),
      at('2026-07-10', 'stA'), at('2026-07-11', 'stA'),
    ];
    const w = detectRestWarnings(shifts);
    assert.strictEqual(w.restViolations.length, 0, 'a rest day breaks the run');
  });

  it('respects a custom maxConsecutive of 6', () => {
    const shifts: ValidationShift[] = [];
    for (let i = 1; i <= 7; i++) shifts.push(at(`2026-07-0${i}`, 'stA'));
    const w = detectRestWarnings(shifts, 6);
    assert.strictEqual(w.restViolations.length, 1);
    assert.strictEqual(w.restViolations[0].maxConsecutive, 7);
  });

  it('isolates guards from each other (no cross-guard double-booking / runs)', () => {
    const w = detectRestWarnings([
      // g1 and g2 both work the same day at different stations — NOT a double-booking.
      at('2026-07-01', 'stA', 'g1'),
      at('2026-07-01', 'stB', 'g2'),
    ]);
    assert.strictEqual(w.doubleBookings.length, 0);
    assert.strictEqual(w.restViolations.length, 0);
  });

  it('ignores shifts with no guardId', () => {
    const w = detectRestWarnings([
      { guardId: null, stationId: 'stA', startTime: '2026-07-01T08:00:00Z' },
      { guardId: undefined, stationId: 'stB', startTime: '2026-07-01T08:00:00Z' },
    ]);
    assert.strictEqual(w.doubleBookings.length, 0);
    assert.strictEqual(w.restViolations.length, 0);
  });

  it('counts a day worked even when stationId is missing (rest-run still tracked)', () => {
    // Days are keyed even without a stationId; only the double-booking check needs
    // distinct stations. 8 consecutive day-keys → rest violation, no double-booking.
    const shifts: ValidationShift[] = [];
    for (let i = 1; i <= 8; i++) {
      shifts.push({ guardId: 'g1', stationId: null, startTime: `2026-07-0${i}T08:00:00Z` });
    }
    const w = detectRestWarnings(shifts);
    assert.strictEqual(w.doubleBookings.length, 0);
    assert.strictEqual(w.restViolations.length, 1);
    assert.strictEqual(w.restViolations[0].maxConsecutive, 8);
  });

  it('returns empty arrays for no shifts', () => {
    const w = detectRestWarnings([]);
    assert.deepStrictEqual(w.doubleBookings, []);
    assert.deepStrictEqual(w.restViolations, []);
  });
});
