/**
 * Unit tests — attendance / clock-in-out (guardShift) domain.
 *
 * Mirrors backend/src/services/communication/__tests__/routing.test.ts: a tiny
 * in-memory fake `db` (no MySQL, no network), sinon for the few external calls,
 * and the REAL functions under test. Coverage focuses on the deterministic core
 * + recently-hardened logic:
 *
 *   Geofence (lib/geofence):           radius in/out, polygon in/out, unparseable
 *                                       coords → null distance (never a false fail).
 *   Rules engine (lib/attendanceRules): on-time/late grace, early-departure,
 *                                       overtime, outside-geofence → pending_review,
 *                                       no-show vs late detection thresholds.
 *   Sessions (attendanceService):       append/close, hasOpenSession, hoursWorked
 *                                       sums per-session (excludes the in→out gap).
 *   Service vs fake db:                 matchScheduledShift picks the covering shift,
 *                                       findOpenOrShiftRecord reuses ONE row per
 *                                       shift/day, applyClockIn persists status +
 *                                       exceptions onto the record.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/attendance/attendance.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import {
  evaluateGeofence,
  haversineDistance,
  pointInPolygon,
} from '../../../src/lib/geofence';
import {
  evaluateClockIn,
  evaluateClockOut,
  detectForShift,
} from '../../../src/lib/attendanceRules';
import { DEFAULT_NOMINA_SETTINGS } from '../../../src/lib/nominaSettings';
import {
  appendSession,
  closeSession,
  hasOpenSession,
  sessionsHoursWorked,
  matchScheduledShift,
  findOpenOrShiftRecord,
  applyClockIn,
} from '../../../src/services/attendanceService';

const S = DEFAULT_NOMINA_SETTINGS; // lateGrace 15, earlyClockout 15, noShow 30, missedClockout 60, overtime 8h, radius 100

const TENANT = 'tenant-A';

// ── A Quito station: lat/lng strings (as stored), 100 m radius. ──────────────
const STATION = { id: 'st-1', latitud: '-0.180653', longitud: '-78.467838', geofenceRadius: 100, postSiteId: 'ps-1', stationName: 'Puesto Centro' };
// A point ~12 m away (well inside) and a point ~3 km away (well outside).
const NEAR = { lat: -0.18066, lng: -78.46785 };
const FAR = { lat: -0.20800, lng: -78.49000 };

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
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
  };
}

/** Tiny in-memory db with just the models the attendance service touches. */
function buildDb(seed: { shifts?: any[]; guardShifts?: any[] } = {}) {
  const shifts = (seed.shifts || []).map(makeRow);
  const guardShifts = (seed.guardShifts || []).map(makeRow);
  const attendanceExceptions: any[] = [];

  const matchWhere = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where || {})) {
      if (v && typeof v === 'object') {
        const ops = v as any;
        const sym = (s: string) => Object.getOwnPropertySymbols(ops).find((x) => x.toString() === s);
        const lte = sym('Symbol(lte)');
        const gte = sym('Symbol(gte)');
        if (lte && !(new Date(row[k]).getTime() <= new Date(ops[lte]).getTime())) return false;
        if (gte && !(new Date(row[k]).getTime() >= new Date(ops[gte]).getTime())) return false;
        if (!lte && !gte) {
          // plain object equality (e.g. null compared via value) — fall through
          if (row[k] !== v) return false;
        }
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  };

  return {
    attendanceExceptionsRef: attendanceExceptions,
    shift: {
      async findAll({ where, order }: any) {
        let rows = shifts.filter((r) => matchWhere(r, where));
        if (order) {
          rows = rows.slice().sort(
            (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
          );
        }
        return rows;
      },
    },
    guardShift: {
      async findOne({ where, order }: any) {
        let rows = guardShifts.filter((r) => matchWhere(r, where));
        if (order) {
          rows = rows.slice().sort(
            (a, b) => new Date(b.punchInTime).getTime() - new Date(a.punchInTime).getTime(),
          );
        }
        return rows[0] || null;
      },
    },
    attendanceException: {
      async findAll() {
        return attendanceExceptions.filter((e) => e.status === 'open');
      },
      async create(data: any) {
        const row = makeRow({ id: `exc-${attendanceExceptions.length + 1}`, ...data });
        attendanceExceptions.push(row);
        return row;
      },
    },
    // applyClockIn → notifyException only fires for actual exception rows; we stub
    // settings.notifications so dispatch isn't reached for the on-time path.
  } as any;
}

// ───────────────────────────── Geofence ─────────────────────────────────────
describe('attendance · geofence', () => {
  it('haversine is ~0 for the same point and grows with separation', () => {
    assert.strictEqual(Math.round(haversineDistance(NEAR.lat, NEAR.lng, NEAR.lat, NEAR.lng)), 0);
    const d = haversineDistance(NEAR.lat, NEAR.lng, FAR.lat, FAR.lng);
    assert.ok(d > 2000 && d < 5000, `expected a few km, got ${Math.round(d)}m`);
  });

  it('a punch inside the radius is NOT outside', () => {
    const r = evaluateGeofence(STATION, NEAR.lat, NEAR.lng, S.geofence.defaultRadiusM);
    assert.strictEqual(r.mode, 'radius');
    assert.ok(r.distanceM != null && r.distanceM <= 100, `distance ${r.distanceM}`);
    assert.strictEqual(r.outside, false);
  });

  it('a punch outside the radius IS outside, with the right radius reported', () => {
    const r = evaluateGeofence(STATION, FAR.lat, FAR.lng, S.geofence.defaultRadiusM);
    assert.strictEqual(r.outside, true);
    assert.strictEqual(r.radiusM, 100);
    assert.ok((r.distanceM as number) > 100);
  });

  it('uses the station geofenceRadius override, not the default', () => {
    // 3 km override → the FAR point now counts as inside.
    const r = evaluateGeofence({ ...STATION, geofenceRadius: 5000 }, FAR.lat, FAR.lng, 100);
    assert.strictEqual(r.radiusM, 5000);
    assert.strictEqual(r.outside, false);
  });

  it('unparseable / missing coords yield null distance and never a false geofence fail', () => {
    const a = evaluateGeofence(STATION, null, null, 100);
    assert.strictEqual(a.distanceM, null);
    assert.strictEqual(a.outside, false);
    const b = evaluateGeofence({ latitud: 'nope', longitud: 'nope', geofenceRadius: 100 }, NEAR.lat, NEAR.lng, 100);
    assert.strictEqual(b.distanceM, null);
    assert.strictEqual(b.outside, false);
  });

  it('prefers a station polygon when ≥3 points are defined', () => {
    const polygon = [
      { lat: -0.181, lng: -78.469 },
      { lat: -0.181, lng: -78.466 },
      { lat: -0.179, lng: -78.466 },
      { lat: -0.179, lng: -78.469 },
    ];
    const station = { ...STATION, geofencePolygon: JSON.stringify(polygon) };
    const inside = evaluateGeofence(station, NEAR.lat, NEAR.lng, 100);
    assert.strictEqual(inside.mode, 'polygon');
    assert.strictEqual(inside.outside, false);
    const outside = evaluateGeofence(station, FAR.lat, FAR.lng, 100);
    assert.strictEqual(outside.mode, 'polygon');
    assert.strictEqual(outside.outside, true);
  });

  it('point-in-polygon ray-cast: a clearly-inside point is inside, far point is outside', () => {
    const sq = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 0 },
    ];
    assert.strictEqual(pointInPolygon(5, 5, sq), true);
    assert.strictEqual(pointInPolygon(50, 50, sq), false);
  });
});

// ───────────────────────────── Clock-in rules ───────────────────────────────
describe('attendance · evaluateClockIn', () => {
  it('on-time within the grace window → on_time, no exceptions', () => {
    const start = new Date('2026-06-24T08:00:00Z');
    const now = new Date('2026-06-24T08:10:00Z'); // 10 min, grace is 15
    const r = evaluateClockIn({ now, scheduledStart: start, distanceM: 10, outsideGeofence: false }, S);
    assert.strictEqual(r.status, 'on_time');
    assert.strictEqual(r.lateMinutes, 0);
    assert.strictEqual(r.exceptions.length, 0);
  });

  it('past the grace window → late + a late_arrival exception with the right lateness', () => {
    const start = new Date('2026-06-24T08:00:00Z');
    const now = new Date('2026-06-24T08:40:00Z'); // 40 min late
    const r = evaluateClockIn({ now, scheduledStart: start, distanceM: 10, outsideGeofence: false }, S);
    assert.strictEqual(r.status, 'late');
    assert.strictEqual(r.lateMinutes, 40);
    const ex = r.exceptions.find((e) => e.type === 'late_arrival');
    assert.ok(ex, 'late_arrival exception expected');
    // 40 > 15*2 → high severity.
    assert.strictEqual(ex!.severity, 'high');
  });

  it('outside-geofence punch (allowed through) → pending_review + outside_geofence exception', () => {
    const start = new Date('2026-06-24T08:00:00Z');
    const now = new Date('2026-06-24T08:05:00Z');
    const r = evaluateClockIn({ now, scheduledStart: start, distanceM: 350, outsideGeofence: true }, S);
    assert.strictEqual(r.status, 'pending_review');
    assert.strictEqual(r.pendingReview, true);
    assert.ok(r.exceptions.some((e) => e.type === 'outside_geofence'));
  });

  it('no scheduled shift (walk-up) → on_time with no lateness math', () => {
    const r = evaluateClockIn(
      { now: new Date('2026-06-24T08:00:00Z'), scheduledStart: null, distanceM: 10, outsideGeofence: false },
      S,
    );
    assert.strictEqual(r.status, 'on_time');
    assert.strictEqual(r.lateMinutes, 0);
  });
});

// ───────────────────────────── Clock-out rules ──────────────────────────────
describe('attendance · evaluateClockOut', () => {
  it('full shift → hoursWorked computed, no early/overtime exceptions', () => {
    const r = evaluateClockOut(
      {
        now: new Date('2026-06-24T16:00:00Z'),
        punchInTime: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: new Date('2026-06-24T16:00:00Z'),
        distanceM: 10,
        outsideGeofence: false,
      },
      S,
    );
    assert.strictEqual(r.hoursWorked, 8);
    assert.strictEqual(r.earlyDepartureMinutes, 0);
    assert.strictEqual(r.overtimeMinutes, 0);
    assert.strictEqual(r.exceptions.length, 0);
  });

  it('leaving well before scheduled end → early_departure', () => {
    const r = evaluateClockOut(
      {
        now: new Date('2026-06-24T15:00:00Z'), // 60 min early, threshold 15
        punchInTime: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: new Date('2026-06-24T16:00:00Z'),
        distanceM: 10,
        outsideGeofence: false,
      },
      S,
    );
    assert.strictEqual(r.status, 'early_departure');
    assert.strictEqual(r.earlyDepartureMinutes, 60);
    assert.ok(r.exceptions.some((e) => e.type === 'early_departure'));
  });

  it('staying past scheduled end → overtime minutes accrue', () => {
    const r = evaluateClockOut(
      {
        now: new Date('2026-06-24T17:30:00Z'), // 90 min past
        punchInTime: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: new Date('2026-06-24T16:00:00Z'),
        distanceM: 10,
        outsideGeofence: false,
      },
      S,
    );
    assert.strictEqual(r.overtimeMinutes, 90);
    assert.strictEqual(r.status, 'overtime');
  });

  it('no scheduled end → overtime from the payroll hours threshold (8h)', () => {
    const r = evaluateClockOut(
      {
        now: new Date('2026-06-24T18:00:00Z'), // 10h worked
        punchInTime: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: null,
        distanceM: 10,
        outsideGeofence: false,
      },
      S,
    );
    assert.strictEqual(r.hoursWorked, 10);
    assert.strictEqual(r.overtimeMinutes, 120); // (10-8)*60
  });

  it('outside-geofence on the way out overrides status to pending_review', () => {
    const r = evaluateClockOut(
      {
        now: new Date('2026-06-24T16:00:00Z'),
        punchInTime: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: new Date('2026-06-24T16:00:00Z'),
        distanceM: 500,
        outsideGeofence: true,
      },
      S,
    );
    assert.strictEqual(r.status, 'pending_review');
    assert.ok(r.exceptions.some((e) => e.type === 'outside_geofence'));
  });
});

// ───────────────────────────── Detection job ────────────────────────────────
describe('attendance · detectForShift', () => {
  const shiftStart = new Date('2026-06-24T08:00:00Z');
  const shiftEnd = new Date('2026-06-24T16:00:00Z');

  it('no clock-in just past grace → late_arrival', () => {
    const now = new Date('2026-06-24T08:20:00Z'); // 20 min, grace 15, noShow 30
    const spec = detectForShift({ now, shiftStart, shiftEnd, hasClockIn: false, hasClockOut: false }, S);
    assert.ok(spec && spec.type === 'late_arrival');
  });

  it('no clock-in past the no-show threshold → no_call_no_show (critical)', () => {
    const now = new Date('2026-06-24T08:45:00Z'); // 45 min > 30
    const spec = detectForShift({ now, shiftStart, shiftEnd, hasClockIn: false, hasClockOut: false }, S);
    assert.ok(spec && spec.type === 'no_call_no_show');
    assert.strictEqual(spec!.severity, 'critical');
  });

  it('clocked in but never out, past the missed-clockout threshold → missed_clockout', () => {
    const now = new Date('2026-06-24T17:30:00Z'); // 90 min past end, threshold 60
    const spec = detectForShift({ now, shiftStart, shiftEnd, hasClockIn: true, hasClockOut: false }, S);
    assert.ok(spec && spec.type === 'missed_clockout');
  });

  it('clocked in and out → no exception', () => {
    const now = new Date('2026-06-24T18:00:00Z');
    const spec = detectForShift({ now, shiftStart, shiftEnd, hasClockIn: true, hasClockOut: true }, S);
    assert.strictEqual(spec, null);
  });
});

// ───────────────────────────── Sessions model ───────────────────────────────
describe('attendance · sessions (one record, many in/out pairs)', () => {
  it('appendSession opens a session; hasOpenSession reflects it', () => {
    const rec: any = { sessions: [] };
    rec.sessions = appendSession(rec, { at: new Date('2026-06-24T08:00:00Z'), lat: 1, lng: 2, distanceM: 5 });
    assert.strictEqual(rec.sessions.length, 1);
    assert.strictEqual(rec.sessions[0].out, null);
    assert.strictEqual(hasOpenSession(rec), true);
  });

  it('closeSession closes the last open session; hasOpenSession flips false', () => {
    const rec: any = { sessions: [] };
    rec.sessions = appendSession(rec, { at: new Date('2026-06-24T08:00:00Z') });
    rec.sessions = closeSession(rec, { at: new Date('2026-06-24T12:00:00Z'), lat: 1, lng: 2, distanceM: 7 });
    assert.strictEqual(hasOpenSession(rec), false);
    assert.ok(rec.sessions[0].out);
    assert.strictEqual(rec.sessions[0].outDistanceM, 7);
  });

  it('hoursWorked SUMS each closed session and EXCLUDES the gap between out and re-in', () => {
    // 08:00→12:00 (4h), gap (lunch) 12:00→13:00, then 13:00→17:00 (4h) = 8h, NOT 9.
    const rec: any = { sessions: [] };
    rec.sessions = appendSession(rec, { at: new Date('2026-06-24T08:00:00Z') });
    rec.sessions = closeSession(rec, { at: new Date('2026-06-24T12:00:00Z') });
    rec.sessions = appendSession(rec, { at: new Date('2026-06-24T13:00:00Z') });
    rec.sessions = closeSession(rec, { at: new Date('2026-06-24T17:00:00Z') });
    assert.strictEqual(sessionsHoursWorked(rec.sessions), 8);
  });

  it('an open (not-yet-closed) session contributes 0 hours', () => {
    const rec: any = { sessions: [] };
    rec.sessions = appendSession(rec, { at: new Date('2026-06-24T08:00:00Z') });
    assert.strictEqual(sessionsHoursWorked(rec.sessions), 0);
  });
});

// ──────────────────── Service functions against the fake db ──────────────────
describe('attendance · matchScheduledShift (fake db)', () => {
  it('picks the shift currently COVERING the punch time', async () => {
    const db = buildDb({
      shifts: [
        { id: 'sh-early', guardId: 'g1', stationId: 'st-1', tenantId: TENANT, startTime: '2026-06-24T00:00:00Z', endTime: '2026-06-24T06:00:00Z' },
        { id: 'sh-now', guardId: 'g1', stationId: 'st-1', tenantId: TENANT, startTime: '2026-06-24T08:00:00Z', endTime: '2026-06-24T16:00:00Z' },
      ],
    });
    const at = new Date('2026-06-24T09:00:00Z');
    const m = await matchScheduledShift(db, { guardUserId: 'g1', stationId: 'st-1', tenantId: TENANT, at });
    assert.strictEqual(m.shiftId, 'sh-now');
    assert.strictEqual(new Date(m.scheduledStart!).toISOString(), '2026-06-24T08:00:00.000Z');
  });

  it('returns nulls when no shift is within the ±12h window', async () => {
    const db = buildDb({ shifts: [] });
    const m = await matchScheduledShift(db, {
      guardUserId: 'g1', stationId: 'st-1', tenantId: TENANT, at: new Date('2026-06-24T09:00:00Z'),
    });
    assert.strictEqual(m.shiftId, null);
    assert.strictEqual(m.scheduledStart, null);
  });
});

describe('attendance · findOpenOrShiftRecord (dedup → ONE row per shift/day)', () => {
  it('returns the existing record keyed by the matched shiftId', async () => {
    const db = buildDb({
      guardShifts: [
        { id: 'gs-1', guardNameId: 'sg1', stationNameId: 'st-1', shiftId: 'sh-now', tenantId: TENANT, deletedAt: null, punchInTime: '2026-06-24T08:01:00Z' },
      ],
    });
    const found = await findOpenOrShiftRecord(db, {
      securityGuardId: 'sg1', stationId: 'st-1', shiftId: 'sh-now', tenantId: TENANT, tz: 'UTC',
      at: new Date('2026-06-24T12:00:00Z'),
    });
    assert.ok(found);
    assert.strictEqual(found.id, 'gs-1');
  });

  it('walk-up (no shiftId): reuses the same-day record at the station', async () => {
    const db = buildDb({
      guardShifts: [
        { id: 'gs-walk', guardNameId: 'sg1', stationNameId: 'st-1', shiftId: null, tenantId: TENANT, deletedAt: null, punchInTime: '2026-06-24T08:30:00Z' },
      ],
    });
    const found = await findOpenOrShiftRecord(db, {
      securityGuardId: 'sg1', stationId: 'st-1', shiftId: null, tenantId: TENANT, tz: 'UTC',
      at: new Date('2026-06-24T14:00:00Z'),
    });
    assert.ok(found);
    assert.strictEqual(found.id, 'gs-walk');
  });
});

describe('attendance · applyClockIn persists the evaluated status onto the record', () => {
  it('a late punch stamps status=late, lateMinutes, geofence flags + a late_arrival exception', async () => {
    const db = buildDb();
    const record = makeRow({
      id: 'gs-late',
      punchInTime: new Date('2026-06-24T08:40:00Z'), // 40 min after the 08:00 shift
      sessions: [],
      deviceInfo: null,
    });
    const station = { ...STATION };
    const sched = {
      shiftId: 'sh-now',
      scheduledStart: new Date('2026-06-24T08:00:00Z'),
      scheduledEnd: new Date('2026-06-24T16:00:00Z'),
    };

    const status = await applyClockIn(db, {
      record,
      station,
      securityGuard: { id: 'sg1', fullName: 'Juan Pérez' },
      guardUserId: 'g1',
      tenantId: TENANT,
      userId: 'g1',
      latitude: NEAR.lat,
      longitude: NEAR.lng,
      settings: S,
      sched,
    });

    assert.strictEqual(status, 'late');
    assert.strictEqual(record.status, 'late');
    assert.strictEqual(record.lateMinutes, 40);
    assert.strictEqual(record.shiftId, 'sh-now');
    assert.strictEqual(record.punchInOutsideGeofence, false); // NEAR is inside the radius
    const exc = db.attendanceExceptionsRef.find((e: any) => e.type === 'late_arrival');
    assert.ok(exc, 'a late_arrival exception row should be persisted');
    assert.strictEqual(exc.guardShiftId, 'gs-late');
    assert.strictEqual(exc.status, 'open');
  });

  it('an on-time, in-radius punch stamps status=on_time and creates NO exception', async () => {
    const db = buildDb();
    const record = makeRow({
      id: 'gs-ok',
      punchInTime: new Date('2026-06-24T08:05:00Z'),
      sessions: [],
      deviceInfo: null,
    });
    const status = await applyClockIn(db, {
      record,
      station: { ...STATION },
      securityGuard: { id: 'sg1', fullName: 'Ana' },
      guardUserId: 'g1',
      tenantId: TENANT,
      userId: 'g1',
      latitude: NEAR.lat,
      longitude: NEAR.lng,
      settings: S,
      sched: {
        shiftId: 'sh-now',
        scheduledStart: new Date('2026-06-24T08:00:00Z'),
        scheduledEnd: new Date('2026-06-24T16:00:00Z'),
      },
    });
    assert.strictEqual(status, 'on_time');
    assert.strictEqual(record.status, 'on_time');
    assert.strictEqual(db.attendanceExceptionsRef.length, 0);
  });
});
