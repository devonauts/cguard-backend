/**
 * Unit tests — shared Horario grid engine (src/services/scheduleGridService.ts).
 *
 * The three "Horario" screens (Programador, Cliente·Cobertura, Vigilante) all
 * paint from this one module and MUST agree cell-for-cell. These tests pin the
 * behaviour the screens depend on:
 *   - a real generated turno always wins over the rotation formula;
 *   - a slot with no turno but WITH a rotation reads 'rest' (libre) or 'gap'
 *     (a real hole in coverage), never a fake libre;
 *   - a slot with no turno and no rotation reads 'none';
 *   - a 19:00–07:00 turno files under its LOCAL calendar day (tenant tz), not
 *     the UTC day its start instant rolls into;
 *   - covering=true when the turno is worked by someone other than the row's
 *     titular vigilante (a sacafranco covering).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g05-scheduling/scheduleGridService.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import {
  rotationStatus,
  tzParts,
  buildDays,
  loadShiftIndex,
  paintCells,
  ShiftIndex,
} from '../../../src/services/scheduleGridService';

const TZ = 'America/Guayaquil'; // UTC-5, no DST

// ---------------------------------------------------------------------------
// Minimal Sequelize-shaped db: only what loadShiftIndex touches.
// ---------------------------------------------------------------------------
function buildDb(shiftRows: any[]) {
  const calls: any[] = [];
  return {
    calls,
    Sequelize: { Op: { gte: Symbol('gte'), lt: Symbol('lt') } },
    shift: {
      async findAll(args: any) {
        calls.push(args);
        return shiftRows;
      },
    },
  } as any;
}

/** Shift row shaped like the Sequelize model loadShiftIndex reads. */
function shiftRow(o: {
  id: string; positionId: string | null; stationId: string; guardId: string | null;
  startTime: string; endTime: string; guardName?: string | null;
}) {
  return {
    id: o.id,
    positionId: o.positionId,
    stationId: o.stationId,
    guardId: o.guardId,
    startTime: new Date(o.startTime),
    endTime: new Date(o.endTime),
    guard: o.guardName === undefined ? null : { id: o.guardId, fullName: o.guardName },
  };
}

describe('scheduleGridService · rotationStatus', () => {
  // 2 day / 2 night / 2 rest, offset 0. dse 0..5 → day,day,night,night,rest,rest.
  const D = 2, N = 2, R = 2;
  it('classifies each slot of the cycle by its position', () => {
    assert.strictEqual(rotationStatus(0, 0, D, N, R), 'day');
    assert.strictEqual(rotationStatus(1, 0, D, N, R), 'day');
    assert.strictEqual(rotationStatus(2, 0, D, N, R), 'night');
    assert.strictEqual(rotationStatus(3, 0, D, N, R), 'night');
    assert.strictEqual(rotationStatus(4, 0, D, N, R), 'rest');
    assert.strictEqual(rotationStatus(5, 0, D, N, R), 'rest');
  });

  it('wraps the cycle (dse 6 == dse 0)', () => {
    assert.strictEqual(rotationStatus(6, 0, D, N, R), 'day');
  });

  it('handles negative (dse - offset) without going out of phase', () => {
    // offset ahead of dse → negative modulo must still land inside the cycle.
    assert.strictEqual(rotationStatus(1, 3, D, N, R), 'rest'); // (1-3) mod 6 = 4 → rest
    assert.strictEqual(rotationStatus(0, 2, D, N, R), 'rest'); // (0-2) mod 6 = 4 → rest
  });

  it('never divides by zero when the cycle is all zeros', () => {
    // cycle floored at 1; a<0 impossible so falls through to rest.
    assert.strictEqual(rotationStatus(0, 0, 0, 0, 0), 'rest');
  });
});

describe('scheduleGridService · tzParts (tenant-tz bucketing)', () => {
  it('files a 19:00 Guayaquil start under the LOCAL day, not the UTC day', () => {
    // 19:00 on the 20th in UTC-5 is stored as 00:00 UTC on the 21st.
    const startUtc = new Date('2026-07-21T00:00:00Z');
    const p = tzParts(startUtc, TZ);
    assert.strictEqual(p.date, '2026-07-20', 'must bucket under local calendar day (20th)');
    assert.strictEqual(p.hour, 19);
    assert.strictEqual(p.hhmm, '19:00');
  });

  it('reads the 07:00 local end time of an overnight turno', () => {
    // 07:00 on the 21st in UTC-5 is 12:00 UTC on the 21st.
    const endUtc = new Date('2026-07-21T12:00:00Z');
    const p = tzParts(endUtc, TZ);
    assert.strictEqual(p.date, '2026-07-21');
    assert.strictEqual(p.hour, 7);
    assert.strictEqual(p.hhmm, '07:00');
  });

  it('agrees with UTC when tenant tz is UTC', () => {
    const p = tzParts(new Date('2026-07-20T07:00:00Z'), 'UTC');
    assert.strictEqual(p.date, '2026-07-20');
    assert.strictEqual(p.hhmm, '07:00');
  });
});

describe('scheduleGridService · loadShiftIndex', () => {
  const start = new Date(Date.UTC(2026, 6, 20));
  const end = new Date(Date.UTC(2026, 6, 21));

  it('indexes an overnight turno on its LOCAL day and marks it night', async () => {
    const db = buildDb([
      shiftRow({
        id: 'sh-1', positionId: 'pos-1', stationId: 'st-1', guardId: 'g-1',
        startTime: '2026-07-21T00:00:00Z', // 19:00 local 20th
        endTime: '2026-07-21T12:00:00Z',   // 07:00 local 21st
        guardName: 'QA Vigilante 20',
      }),
    ]);
    const idx: ShiftIndex = await loadShiftIndex(db, 'ten-1', ['st-1'], start, end, TZ);

    const byPos = idx.byPosDate.get('pos-1|2026-07-20');
    assert.ok(byPos, 'turno must be keyed on the LOCAL day column (20th), not the UTC 21st');
    assert.strictEqual(byPos.status, 'night');
    assert.strictEqual(byPos.hours, '19:00 - 07:00');
    assert.strictEqual(byPos.guardName, 'QA Vigilante 20');
    assert.strictEqual(byPos.guardId, 'g-1');

    // guard+station fallback key is also populated.
    assert.ok(idx.byGuardStationDate.get('g-1|st-1|2026-07-20'));
    // NOT under the UTC day.
    assert.strictEqual(idx.byPosDate.get('pos-1|2026-07-21'), undefined);
  });

  it('classifies an 07:00 day-shift start as day', async () => {
    const db = buildDb([
      shiftRow({
        id: 'sh-2', positionId: 'pos-2', stationId: 'st-1', guardId: 'g-2',
        startTime: '2026-07-20T12:00:00Z', // 07:00 local
        endTime: '2026-07-21T00:00:00Z',   // 19:00 local
        guardName: 'QA Vigilante 01',
      }),
    ]);
    const idx = await loadShiftIndex(db, 'ten-1', ['st-1'], start, end, TZ);
    const cell = idx.byPosDate.get('pos-2|2026-07-20');
    assert.ok(cell);
    assert.strictEqual(cell.status, 'day');
    assert.strictEqual(cell.hours, '07:00 - 19:00');
  });

  it('returns empty maps and issues no query when there are no stations', async () => {
    const db = buildDb([]);
    const idx = await loadShiftIndex(db, 'ten-1', [], start, end, TZ);
    assert.strictEqual(idx.byPosDate.size, 0);
    assert.strictEqual(idx.byGuardStationDate.size, 0);
    assert.strictEqual(db.calls.length, 0, 'no station → no findAll');
  });
});

describe('scheduleGridService · paintCells', () => {
  const days = buildDays(
    new Date(Date.UTC(2026, 6, 20)),
    new Date(Date.UTC(2026, 6, 20)),
    '2026-07-20',
  );

  const emptyIndex = (): ShiftIndex => ({ byPosDate: new Map(), byGuardStationDate: new Map() });

  it('a real generated turno WINS over the rotation formula', () => {
    const idx = emptyIndex();
    idx.byPosDate.set('pos-1|2026-07-20', {
      status: 'night', hours: '19:00 - 07:00', guardId: 'g-1', guardName: 'QA Vigilante 20',
    });
    // Rotation math would call this a rest day; the real turno must override it.
    const cells = paintCells(days, idx, {
      positionId: 'pos-1', stationId: 'st-1', guardId: 'g-1',
      rot: { dayShifts: 0, nightShifts: 0, restDays: 1 }, platoon: 0,
    });
    assert.strictEqual(cells[0].status, 'night');
    assert.strictEqual(cells[0].hours, '19:00 - 07:00');
    assert.strictEqual(cells[0].covering, false);
  });

  it('no turno + rotation expecting a libre → rest', () => {
    const cells = paintCells(days, emptyIndex(), {
      positionId: 'pos-x', stationId: 'st-1', guardId: 'g-1',
      // all-rest cycle → every day is a libre.
      rot: { dayShifts: 0, nightShifts: 0, restDays: 1 }, platoon: 0,
    });
    assert.strictEqual(cells[0].status, 'rest');
    assert.strictEqual(cells[0].hours, null);
  });

  it('no turno + rotation expecting WORK → gap (a real hole, not a fake libre)', () => {
    const cells = paintCells(days, emptyIndex(), {
      positionId: 'pos-x', stationId: 'st-1', guardId: 'g-1',
      // all-day cycle → the formula expected a worked day, but no turno exists.
      rot: { dayShifts: 1, nightShifts: 0, restDays: 0 }, platoon: 0,
    });
    assert.strictEqual(cells[0].status, 'gap');
  });

  it('no turno + no rotation → none', () => {
    const cells = paintCells(days, emptyIndex(), {
      positionId: 'pos-x', stationId: 'st-1', guardId: 'g-1', rot: null,
    });
    assert.strictEqual(cells[0].status, 'none');
    assert.strictEqual(cells[0].hours, null);
    assert.strictEqual(cells[0].guardName, null);
  });

  it('covering=true when a DIFFERENT vigilante works the row\'s slot', () => {
    const idx = emptyIndex();
    idx.byGuardStationDate.set('titular|st-1|2026-07-20', {
      status: 'day', hours: '07:00 - 19:00', guardId: 'sacafranco', guardName: 'QA Vigilante 30',
    });
    const cells = paintCells(days, idx, {
      positionId: null, stationId: 'st-1', guardId: 'titular', rot: null,
    });
    // NOTE: this fallback key is (guardId|stationId|date); the seeded entry is
    // keyed on the titular but carries a different worker → covering.
    assert.strictEqual(cells[0].status, 'day');
    assert.strictEqual(cells[0].covering, true);
    assert.strictEqual(cells[0].guardName, 'QA Vigilante 30');
  });

  it('covering=false when the titular works their own slot', () => {
    const idx = emptyIndex();
    idx.byPosDate.set('pos-1|2026-07-20', {
      status: 'day', hours: '07:00 - 19:00', guardId: 'titular', guardName: 'QA Vigilante 01',
    });
    const cells = paintCells(days, idx, {
      positionId: 'pos-1', stationId: 'st-1', guardId: 'titular', rot: null,
    });
    assert.strictEqual(cells[0].covering, false);
  });
});
