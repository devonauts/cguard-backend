/**
 * Unit tests — optimizeSacafrancos END-TO-END + the two operative guarantees the
 * Programador must never violate:
 *
 *   (A) NO DOUBLE-BOOKING: after a full tenant-wide sacafranco optimization, no
 *       vigilante holds two shifts that overlap in time. A guard cannot be in two
 *       stations at the same instant — a coverage gap is preferable to a
 *       physically-impossible double-booking. (shiftGenerationService's backstop:
 *       lines ~548-581.)
 *
 *   (B) A SACAFRANCO CAN cover DIFFERENT puestos at NON-overlapping times: the SF
 *       hops between stations across its work-days (day-block → night-block →
 *       rest), landing wherever a fijo rests — proving relief is real and global,
 *       yet never self-overlapping.
 *
 *   (C) ALTERNANCIA 24×24 (restCoverage='alternate', 1-1 rotation, 2 fijos sharing
 *       one block): ZERO sacafranco demand (one fijo works every day), and the
 *       alternation phase is date-driven — offset ≡ dse(startDate) mod cycle so
 *       "empieza hoy ⇒ trabaja hoy".
 *
 * Everything runs against an in-memory, Sequelize-shaped fake db (Op-operator
 * aware) + sinon fake timers. No MySQL, no network. Pattern mirrors
 * tests/unit/crud-g05-scheduling/*.test.ts.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/programador/optimizeNoDouble.test.ts' --exit --timeout 15000
 */

import assert from 'assert';
import sinon from 'sinon';
import { Op } from 'sequelize';

import { optimizeSacafrancos, computeShiftsForAssignment } from '../../../src/services/shiftGenerationService';
import { createAssignment } from '../../../src/services/assignmentService';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const USER_ID = 'user-admin-1';
const TZ = 'UTC'; // deterministic wall-clock ⇄ UTC mapping

// ─────────────────────────────────────────────────────────────────────────────
// Sequelize-shaped fake db — Op-operator aware (so scoped destroys/finds actually
// filter, instead of the pass-through matcher used by the pure CRUD tests).
// ─────────────────────────────────────────────────────────────────────────────

function toCmp(v: any): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /\d{4}-\d\d-\d\dT/.test(v)) return new Date(v).getTime();
  return v;
}

/** Evaluate one field constraint (plain value, array, null, or Op-object). */
function matchField(rowVal: any, cond: any): boolean {
  if (cond === null) return rowVal === null || rowVal === undefined;
  if (Array.isArray(cond)) return cond.map(String).includes(String(rowVal));
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    // Op-keyed object: every operator must hold.
    for (const sym of Object.getOwnPropertySymbols(cond)) {
      const v = (cond as any)[sym];
      if (sym === Op.ne) { if (v === null ? (rowVal === null || rowVal === undefined) : String(rowVal) === String(v)) return false; }
      else if (sym === Op.in) { if (!(v as any[]).map(String).includes(String(rowVal))) return false; }
      else if (sym === Op.gte) { if (!(toCmp(rowVal) >= toCmp(v))) return false; }
      else if (sym === Op.lte) { if (!(toCmp(rowVal) <= toCmp(v))) return false; }
      else if (sym === Op.gt) { if (!(toCmp(rowVal) > toCmp(v))) return false; }
      else if (sym === Op.lt) { if (!(toCmp(rowVal) < toCmp(v))) return false; }
    }
    // Any string keys inside (rare) fall through as equality.
    for (const k of Object.keys(cond)) { if (String(rowVal) !== String((cond as any)[k])) return false; }
    return true;
  }
  return String(rowVal) === String(cond);
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    if (!matchField(row[key], where[key])) return false;
  }
  // Symbol-keyed top-level combinators (Op.or / Op.and).
  for (const sym of Object.getOwnPropertySymbols(where)) {
    const subs = (where as any)[sym] as any[];
    if (sym === Op.or) { if (!subs.some((w) => matchWhere(row, w))) return false; }
    else if (sym === Op.and) { if (!subs.every((w) => matchWhere(row, w))) return false; }
  }
  return true;
}

function applyOrder(rows: any[], order?: any[]): any[] {
  if (!order || !order.length) return rows;
  return rows.slice().sort((a, b) => {
    for (const o of order) {
      const field = Array.isArray(o) ? o[0] : o;
      const dir = Array.isArray(o) && String(o[1]).toUpperCase() === 'DESC' ? -1 : 1;
      const av = toCmp(a[field]); const bv = toCmp(b[field]);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

function makeRow(data: any) {
  const row: any = {
    ...data,
    async update(patch: any) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        row[k] = v;
      }
      return row;
    },
    get() { const { update, get, ...rest } = row; void update; void get; return { ...rest }; },
  };
  return row;
}

function makeModel(name: string) {
  let seq = 0;
  const model: any = {
    name,
    rows: [] as any[],
    calls: { create: [] as any[], update: [] as any[], destroy: [] as any[] },
    async create(data: any) {
      const row = makeRow({ id: data.id || `${name}-${++seq}`, ...data });
      model.calls.create.push({ ...data });
      model.rows.push(row);
      return row;
    },
    async bulkCreate(rows: any[]) {
      return rows.map((r) => {
        const row = makeRow({ id: r.id || `${name}-${++seq}`, ...r });
        model.rows.push(row);
        return row;
      });
    },
    async findAll(q: any = {}) {
      let out = model.rows.filter((r: any) => matchWhere(r, q.where));
      if (q.group) {
        const keys: string[] = Array.isArray(q.group) ? q.group : [q.group];
        const seen = new Set<string>();
        out = out.filter((r: any) => {
          const k = keys.map((g) => String(r[g])).join('|');
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
      }
      return applyOrder(out, q.order);
    },
    async findOne(q: any = {}) {
      const out = applyOrder(model.rows.filter((r: any) => matchWhere(r, q.where)), q.order);
      return out[0] || null;
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => matchWhere(r, q.where)).length;
    },
    async update(patch: any, q: any = {}) {
      model.calls.update.push({ patch: { ...patch }, where: q.where || {} });
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      for (const r of victims) await r.update(patch);
      return [victims.length];
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q.where || {});
      const before = model.rows.length;
      const survivors = model.rows.filter((r: any) => !matchWhere(r, q.where));
      model.rows.length = 0;
      model.rows.push(...survivors);
      return before - survivors.length;
    },
  };
  return model;
}

function buildDb() {
  const db: any = {
    Sequelize: { Op },
    sequelize: {
      // Fake transaction: run the callback with a stub tx; models ignore it.
      async transaction(cb: any) { return cb({ id: 'tx' }); },
    },
    tenant: makeModel('tenant'),
    station: makeModel('station'),
    stationPosition: makeModel('stationPosition'),
    rotationStyle: makeModel('rotationStyle'),
    guardAssignment: makeModel('guardAssignment'),
    shift: makeModel('shift'),
    tenantUser: makeModel('tenantUser'),
    securityGuard: makeModel('securityGuard'),
    user: makeModel('user'),
  };
  db.tenant.rows.push(makeRow({ id: TENANT, timezone: TZ }));
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers over the resulting shift table.
// ─────────────────────────────────────────────────────────────────────────────

function liveShifts(db: any): any[] {
  return db.shift.rows.map((r: any) => ({
    guardId: r.guardId,
    stationId: String(r.stationId),
    positionId: r.positionId,
    start: new Date(r.startTime).getTime(),
    end: new Date(r.endTime).getTime(),
  }));
}

function overlaps(a: any, b: any): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Every guard's shifts, pairwise, must not overlap in time. Returns offenders. */
function doubleBookings(shifts: any[]): { guardId: string; a: any; b: any }[] {
  const byGuard = new Map<string, any[]>();
  for (const s of shifts) {
    if (!byGuard.has(s.guardId)) byGuard.set(s.guardId, []);
    byGuard.get(s.guardId)!.push(s);
  }
  const out: { guardId: string; a: any; b: any }[] = [];
  for (const [guardId, list] of byGuard) {
    const sorted = list.slice().sort((x, y) => x.start - y.start);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start >= sorted[i].end) break; // sorted by start → no later overlap
        if (overlaps(sorted[i], sorted[j])) out.push({ guardId, a: sorted[i], b: sorted[j] });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario seeding.
// ─────────────────────────────────────────────────────────────────────────────

const START = '2026-06-01'; // in the past ⇒ genStart floors to "today"
const END = '2026-07-20';   // ~19-day window from today (fast + shows 2 SF cycles)

/** Seed a 4-4-2 sacafranco system rotation style; return its id. */
function seed442(db: any): string {
  const rot = makeRow({ id: 'rot-442', name: '4-4-2', isSystem: true, dayShifts: 4, nightShifts: 4, restDays: 2 });
  db.rotationStyle.rows.push(rot);
  return 'rot-442';
}

/** One 24h station with two fijos (offsets staggered by dayShifts) + their guards. */
function seedStation(db: any, sid: string, rotId: string, guardA: string, guardB: string, offA: number) {
  db.station.rows.push(makeRow({
    id: sid, tenantId: TENANT, stationName: sid, rotationStyleId: rotId,
    scheduleType: '24h', postSiteId: `ps-${sid}`, deletedAt: null,
  }));
  const posA = makeRow({ id: `${sid}-fa`, tenantId: TENANT, stationId: sid, type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: offA, deletedAt: null });
  const posB = makeRow({ id: `${sid}-fb`, tenantId: TENANT, stationId: sid, type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 1, platoonOffset: (offA + 4) % 10, deletedAt: null });
  db.stationPosition.rows.push(posA, posB);
  for (const [g, pos] of [[guardA, posA], [guardB, posB]] as const) {
    db.tenantUser.rows.push(makeRow({ id: `tu-${g}`, tenantId: TENANT, userId: g }));
    db.guardAssignment.rows.push(makeRow({
      id: `ga-${g}`, tenantId: TENANT, guardId: g, stationId: sid, positionId: pos.id,
      rotationStyleId: null, startDate: START, endDate: END, platoonOffset: pos.platoonOffset,
      isRelief: false, kind: 'rotation', status: 'active', deletedAt: null,
    }));
  }
}

/** Seed one sacafranco position + one SF guard assignment. */
function seedSf(db: any, homeStation: string, guard: string, rotId: string) {
  const pos = makeRow({ id: 'sf-pos-1', tenantId: TENANT, stationId: homeStation, type: 'sacafranco', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 100, platoonOffset: 0, deletedAt: null });
  db.stationPosition.rows.push(pos);
  db.tenantUser.rows.push(makeRow({ id: `tu-${guard}`, tenantId: TENANT, userId: guard }));
  db.guardAssignment.rows.push(makeRow({
    id: `ga-${guard}`, tenantId: TENANT, guardId: guard, stationId: homeStation, positionId: pos.id,
    rotationStyleId: rotId, startDate: START, endDate: END, platoonOffset: 0,
    isRelief: true, kind: 'rotation', status: 'active', deletedAt: null,
    coveredStationIds: null,
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// (A) + (B): optimize end-to-end, no double-booking, SF hops distinct stations.
// ═════════════════════════════════════════════════════════════════════════════

describe('programador · optimizeSacafrancos end-to-end (no double-booking)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers({ now: new Date('2026-07-01T12:00:00Z').getTime(), toFake: ['Date'] }); });
  afterEach(() => clock.restore());

  it('runs to completion over 3 stations + 1 SF and reports a coherent plan', async () => {
    const db = buildDb();
    const rot = seed442(db);
    seedStation(db, 'st-A', rot, 'g-A1', 'g-A2', 0);
    seedStation(db, 'st-B', rot, 'g-B1', 'g-B2', 2);
    seedStation(db, 'st-C', rot, 'g-C1', 'g-C2', 4);
    seedSf(db, 'st-A', 'g-SF', rot);

    const res = await optimizeSacafrancos(db, TENANT, USER_ID);

    assert.ok(res.details, 'returns details');
    assert.strictEqual(res.details.totalStations, 3, '3 stations with fijos');
    // With every station on 4-4-2 there are real rest-gaps ⇒ at least one SF planned.
    assert.ok(res.details.sacafrancosNeeded >= 1, 'a multi-station 4-4-2 tenant needs ≥1 sacafranco');
    // The planner must land every gap inside the SF's day/night blocks (feasible).
    assert.strictEqual(res.details.outOfBlockGaps, 0, 'a feasible plan leaves zero out-of-block gaps');
    // Shifts were regenerated.
    assert.ok(db.shift.rows.length > 0, 'shifts were generated');
  });

  it('NO vigilante ends with two overlapping shifts (different stations, same instant)', async () => {
    const db = buildDb();
    const rot = seed442(db);
    seedStation(db, 'st-A', rot, 'g-A1', 'g-A2', 0);
    seedStation(db, 'st-B', rot, 'g-B1', 'g-B2', 2);
    seedStation(db, 'st-C', rot, 'g-C1', 'g-C2', 4);
    seedSf(db, 'st-A', 'g-SF', rot);

    await optimizeSacafrancos(db, TENANT, USER_ID);

    const shifts = liveShifts(db);
    const clashes = doubleBookings(shifts);
    assert.deepStrictEqual(
      clashes.map((c) => `${c.guardId}: [${new Date(c.a.start).toISOString()}@${c.a.stationId}] vs [${new Date(c.b.start).toISOString()}@${c.b.stationId}]`),
      [],
      'no guard may hold two overlapping shifts',
    );
  });

  it('the SACAFRANCO covers DIFFERENT puestos at NON-overlapping times', async () => {
    const db = buildDb();
    const rot = seed442(db);
    seedStation(db, 'st-A', rot, 'g-A1', 'g-A2', 0);
    seedStation(db, 'st-B', rot, 'g-B1', 'g-B2', 2);
    seedStation(db, 'st-C', rot, 'g-C1', 'g-C2', 4);
    seedSf(db, 'st-A', 'g-SF', rot);

    await optimizeSacafrancos(db, TENANT, USER_ID);

    const sfShifts = liveShifts(db).filter((s) => s.guardId === 'g-SF');
    assert.ok(sfShifts.length > 0, 'the SF actually works (covers real gaps)');

    // (B.1) The SF NEVER self-overlaps.
    const selfClash = doubleBookings(sfShifts);
    assert.deepStrictEqual(selfClash, [], 'a sacafranco never doubles itself up');

    // (B.2) The SF reaches MORE THAN ONE station — real global relief, hopping.
    const stations = new Set(sfShifts.map((s) => s.stationId));
    assert.ok(stations.size >= 2, `SF should cover ≥2 distinct stations, covered ${stations.size} (${[...stations].join(',')})`);

    // (B.3) There EXISTS a pair of SF shifts at DIFFERENT stations that do not overlap.
    let foundDistinctNonOverlap = false;
    for (let i = 0; i < sfShifts.length && !foundDistinctNonOverlap; i++) {
      for (let j = i + 1; j < sfShifts.length; j++) {
        if (sfShifts[i].stationId !== sfShifts[j].stationId && !overlaps(sfShifts[i], sfShifts[j])) {
          foundDistinctNonOverlap = true; break;
        }
      }
    }
    assert.ok(foundDistinctNonOverlap, 'SF covers distinct stations at non-overlapping times');
  });

  it('(I1 LIBRES) every FIJO rests on some day of the window — never works the whole window', async () => {
    const db = buildDb();
    const rot = seed442(db);
    seedStation(db, 'st-A', rot, 'g-A1', 'g-A2', 0);
    seedStation(db, 'st-B', rot, 'g-B1', 'g-B2', 2);
    seedStation(db, 'st-C', rot, 'g-C1', 'g-C2', 4);
    seedSf(db, 'st-A', 'g-SF', rot);

    await optimizeSacafrancos(db, TENANT, USER_ID);

    // Window is 19 days; a 4-4-2 fijo (cycle 10) must rest ≥2 days in that span.
    const fijoGuards = ['g-A1', 'g-A2', 'g-B1', 'g-B2', 'g-C1', 'g-C2'];
    const shifts = liveShifts(db);
    const daySpan = (new Date(`${END}T00:00:00Z`).getTime() - new Date('2026-07-01T00:00:00Z').getTime()) / 86400000 + 1;
    for (const g of fijoGuards) {
      const workedDays = new Set(shifts.filter((s) => s.guardId === g).map((s) => new Date(s.start).toISOString().slice(0, 10)));
      assert.ok(workedDays.size > 0, `${g} must work at least some days`);
      assert.ok(workedDays.size < daySpan, `${g} must rest at least one day (worked ${workedDays.size}/${daySpan})`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (C) ALTERNANCIA 24×24 — restCoverage='alternate', 1-1 rotation, 2 fijos.
// ═════════════════════════════════════════════════════════════════════════════

describe('programador · alternancia 24×24 (0 SF demand + date-driven phase)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers({ now: new Date('2026-07-01T12:00:00Z').getTime(), toFake: ['Date'] }); });
  afterEach(() => clock.restore());

  /** Seed one custom/alternate station: 1-1 rotation, two fijos phased opposite. */
  function seedAlternateStation(db: any, offset0: number) {
    db.rotationStyle.rows.push(makeRow({ id: 'rot-11', name: '1-1', isSystem: false, dayShifts: 1, nightShifts: 0, restDays: 1 }));
    // 4-4-2 must still exist so the SF-rotation resolver finds a default.
    seed442(db);
    db.station.rows.push(makeRow({
      id: 'st-X', tenantId: TENANT, stationName: 'st-X', rotationStyleId: 'rot-11',
      scheduleType: 'custom', postSiteId: 'ps-X', deletedAt: null,
    }));
    const cycle = 2;
    const off2 = ((offset0 - 1) % cycle + cycle) % cycle;
    db.stationPosition.rows.push(
      makeRow({ id: 'st-X-f1', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: offset0, deletedAt: null }),
      makeRow({ id: 'st-X-f2', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', guardsNeeded: 1, sortOrder: 1, platoonOffset: off2, deletedAt: null }),
    );
    for (const [g, pid, off] of [['g-X1', 'st-X-f1', offset0], ['g-X2', 'st-X-f2', off2]] as const) {
      db.tenantUser.rows.push(makeRow({ id: `tu-${g}`, tenantId: TENANT, userId: g }));
      db.guardAssignment.rows.push(makeRow({
        id: `ga-${g}`, tenantId: TENANT, guardId: g, stationId: 'st-X', positionId: pid,
        rotationStyleId: null, startDate: START, endDate: END, platoonOffset: off,
        isRelief: false, kind: 'rotation', status: 'active', deletedAt: null,
      }));
    }
  }

  it('an alternate station (2 fijos, 1 works every day) needs ZERO sacafrancos', async () => {
    const db = buildDb();
    seedAlternateStation(db, 0);

    const res = await optimizeSacafrancos(db, TENANT, USER_ID);
    assert.strictEqual(res.details.sacafrancosNeeded, 0, 'alternation covers itself ⇒ no SF demand');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG (documented, NOT fixed): optimizeSacafrancos re-plans EVERY station that
  // has a rotationStyle — including custom/alternate ones — and normalizes their
  // fijo offsets to the planner's canonical 0,1,… stagger. For an alternate 24×24
  // station this CLOBBERS the date-driven phase createAssignment set
  // (offset ≡ dse(startDate) mod cycle, "empieza hoy ⇒ trabaja hoy"), silently
  // flipping WHICH guard works today. Worse, because the alternate tenant needs 0
  // SFs, optimize RETURNS EARLY (targetSfCount===0) AFTER writing the new offsets
  // to positions+assignments but BEFORE regenerating shifts — so the already
  // generated shifts keep the OLD phase: config vs calendar desync until some
  // other action regenerates.
  //   Input : alternate station, fijos phased [1,0] (an odd-dse startDate),
  //           one pre-existing shift for fijo-1 reflecting offset 1.
  //   Expected: offset preserved at 1 (date-driven phase is authoritative), OR
  //           shifts regenerated to match the new phase.
  //   Actual : position/assignment offset silently rewritten 1→0 AND the stale
  //           shift left untouched (no regen).
  // FIXED (2026-07-20): optimize now EXCLUDES alternate stations (custom + ≥2
  // fijos sharing a block) from offset re-planning, so their date-driven phase
  // ("Carlos hoy, Leonardo mañana") survives an optimize run.
  it('optimize PRESERVES the alternation phase (offset stays 1, not clobbered to 0)', async () => {
    const db = buildDb();
    // Seed the "odd-dse" phase: fijo-1 offset 1, fijo-2 offset 0.
    db.rotationStyle.rows.push(makeRow({ id: 'rot-11', name: '1-1', isSystem: false, dayShifts: 1, nightShifts: 0, restDays: 1 }));
    seed442(db);
    db.station.rows.push(makeRow({ id: 'st-X', tenantId: TENANT, stationName: 'st-X', rotationStyleId: 'rot-11', scheduleType: 'custom', postSiteId: 'ps-X', deletedAt: null }));
    db.stationPosition.rows.push(
      makeRow({ id: 'st-X-f1', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', sortOrder: 0, platoonOffset: 1, deletedAt: null }),
      makeRow({ id: 'st-X-f2', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', sortOrder: 1, platoonOffset: 0, deletedAt: null }),
    );
    for (const [g, pid, off] of [['g-X1', 'st-X-f1', 1], ['g-X2', 'st-X-f2', 0]] as const) {
      db.tenantUser.rows.push(makeRow({ id: `tu-${g}`, tenantId: TENANT, userId: g }));
      db.guardAssignment.rows.push(makeRow({ id: `ga-${g}`, tenantId: TENANT, guardId: g, stationId: 'st-X', positionId: pid, rotationStyleId: null, startDate: START, endDate: END, platoonOffset: off, isRelief: false, kind: 'rotation', status: 'active', deletedAt: null }));
    }
    // A shift already on the calendar reflecting fijo-1's OLD phase (offset 1).
    db.shift.rows.push(makeRow({ id: 'pre-existing', tenantId: TENANT, guardId: 'g-X1', stationId: 'st-X', positionId: 'st-X-f1', startTime: new Date('2026-07-10T07:00:00Z'), endTime: new Date('2026-07-11T07:00:00Z') }));

    const res = await optimizeSacafrancos(db, TENANT, USER_ID);
    assert.strictEqual(res.details.sacafrancosNeeded, 0, 'alternate ⇒ still 0 SFs');

    const f1After = db.stationPosition.rows.find((r: any) => r.id === 'st-X-f1').platoonOffset;
    const gaAfter = db.guardAssignment.rows.find((r: any) => r.id === 'ga-g-X1').platoonOffset;
    // FIXED: the alternate station is excluded from planning, so its date-driven
    // phase is preserved (offset stays 1) on both the position and the assignment.
    assert.strictEqual(f1After, 1, 'position offset preserved (alternation phase intact)');
    assert.strictEqual(gaAfter, 1, 'assignment offset preserved');
    // Phase unchanged ⇒ the pre-existing shift still matches the calendar (no desync).
    assert.ok(db.shift.rows.find((r: any) => r.id === 'pre-existing'), 'calendar stays consistent with the preserved phase');
  });

  it('alternate coverage: exactly one fijo works EACH day (día por medio, no double-staff, no gap)', async () => {
    // NOTE: optimizeSacafrancos short-circuits when 0 SFs are needed and does NOT
    // regenerate fijo shifts, so we prove the alternation coverage invariant from
    // the pure generator (computeShiftsForAssignment) over the two fijos directly.
    const db = buildDb();
    seedAlternateStation(db, 0);

    const a1 = db.guardAssignment.rows.find((r: any) => r.id === 'ga-g-X1').get();
    const a2 = db.guardAssignment.rows.find((r: any) => r.id === 'ga-g-X2').get();
    const s1 = await computeShiftsForAssignment(db, a1, TENANT);
    const s2 = await computeShiftsForAssignment(db, a2, TENANT);

    const byDay = new Map<string, Set<string>>();
    for (const s of [...s1, ...s2]) {
      const d = new Date(s.startTime).toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, new Set());
      byDay.get(d)!.add(s.guardId);
    }
    const daySpan = (new Date(`${END}T00:00:00Z`).getTime() - new Date('2026-07-01T00:00:00Z').getTime()) / 86400000 + 1;
    assert.strictEqual(byDay.size, daySpan, `every day in the window is covered (got ${byDay.size}/${daySpan})`);
    for (const [d, guards] of byDay) {
      assert.strictEqual(guards.size, 1, `exactly one fijo works ${d} (alternation, not double-staff)`);
    }
    // Each fijo works its restDays share: half the window (día por medio).
    assert.ok(s1.length > 0 && s2.length > 0, 'both fijos work some days (I1: nobody works 0)');
  });

  it('(offset phase) createAssignment derives the fijo phase from startDate: offset ≡ dse(startDate) mod cycle', async () => {
    // Independent, deterministic check of the "empieza hoy ⇒ trabaja hoy" rule.
    const db = buildDb();
    db.rotationStyle.rows.push(makeRow({ id: 'rot-11', dayShifts: 1, nightShifts: 0, restDays: 1 }));
    db.station.rows.push(makeRow({ id: 'st-X', tenantId: TENANT, scheduleType: 'custom', rotationStyleId: 'rot-11', deletedAt: null }));
    // Two fijos SHARING the same block ⇒ the alternation (date-driven phase) branch fires.
    db.stationPosition.rows.push(
      makeRow({ id: 'st-X-f1', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', platoonOffset: 0, deletedAt: null }),
      makeRow({ id: 'st-X-f2', tenantId: TENANT, stationId: 'st-X', type: 'fijo', startTime: '07:00', endTime: '07:00', platoonOffset: 1, deletedAt: null }),
    );
    db.tenantUser.rows.push(makeRow({ id: 'tu-g-X1', tenantId: TENANT, userId: 'g-X1' }));

    const startDate = '2026-07-20';
    await createAssignment(db, TENANT, USER_ID, { guardId: 'g-X1', stationId: 'st-X', positionId: 'st-X-f1', startDate });

    const cycle = 2;
    const dseStart = Math.floor((Date.parse(`${startDate}T00:00:00Z`) - Date.UTC(2024, 0, 1)) / 86400000);
    const expected = ((dseStart % cycle) + cycle) % cycle;
    const created = db.guardAssignment.calls.create[0];
    assert.strictEqual(created.platoonOffset, expected, 'alternation phase must come from startDate, not the epoch offset');
  });
});
