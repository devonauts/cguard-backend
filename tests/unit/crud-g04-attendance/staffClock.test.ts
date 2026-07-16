/**
 * CRUD persistence tests — staff (administrative web time clock, src/api/staff/clock.ts).
 *
 * The staff clock writes staffShift rows directly from the handler, so these
 * tests drive the REAL handlers with a fake req/res + in-memory db:
 *   - clock-in persists EVERY field the kiosk sends (selfie, address, battery,
 *     checklist, coords, geofence snapshot),
 *   - clock-out lands the punch-out fields + closes breaks + computes hours,
 *   - a blocked geofence punch writes NOTHING,
 *   - a db failure surfaces as an error response (NOT a 200 success).
 *
 * dispatch() (realtime fan-out) is stubbed — it's best-effort by design.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g04-attendance/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import * as dispatcherModule from '../../../src/lib/notificationDispatcher';
import { clockIn, clockOut, breakStart, breakEnd } from '../../../src/api/staff/clock';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const USER_ID = 'user-staff-1';

// Quito office + a point well inside / well outside a 150 m radius.
const OFFICE = { lat: -0.180653, lng: -78.467838 };
const NEAR = { lat: -0.18066, lng: -78.46785 }; // ~12 m
const FAR = { lat: -0.208, lng: -78.49 }; // ~3 km

function staffUser(overrides: any = {}) {
  return {
    id: USER_ID,
    fullName: 'Ofelia Admin',
    email: 'ofelia@test.dev',
    emailVerified: true,
    tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
    ...overrides,
  };
}

function makeRow(data: any) {
  const row: any = {
    ...data,
    updateCalls: [] as any[],
    get(opts?: any) {
      if (typeof opts === 'string') return data[opts];
      return { ...data };
    },
    async update(patch: any) {
      row.updateCalls.push({ ...patch });
      Object.assign(data, patch);
      Object.assign(row, patch);
      return row;
    },
  };
  return row;
}

function buildDb(seed: { staffShifts?: any[] } = {}) {
  const rows = (seed.staffShifts || []).map(makeRow);
  const createCalls: any[] = [];
  const db: any = {
    rows,
    createCalls,
    staffShift: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeRow({ id: `ss-new-${createCalls.length}`, ...payload });
        rows.push(row);
        return row;
      },
      async findOne({ where }: any) {
        return (
          rows.find(
            (r: any) =>
              r.tenantId === where.tenantId &&
              r.userId === where.userId &&
              (r.punchOutTime ?? null) === null,
          ) || null
        );
      },
    },
  };
  return db;
}

function mkReq(db: any, user: any, data: any = {}) {
  return {
    database: db,
    currentTenant: { id: TENANT },
    currentUser: user,
    body: { data },
    language: 'es',
    params: {},
  } as any;
}

function mkRes() {
  const res: any = {
    statusCode: null as number | null,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(payload: any) {
      res.body = payload;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      return res;
    },
    header() {
      return res;
    },
  };
  return res;
}

describe('crud-g04 · staff clock (staffShift)', () => {
  let dispatchStub: sinon.SinonStub;

  beforeEach(() => {
    if ((dispatcherModule as any).dispatch?.restore) (dispatcherModule as any).dispatch.restore();
    dispatchStub = sinon.stub(dispatcherModule, 'dispatch').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  describe('clock-in — field fidelity', () => {
    it('persists EVERY field the kiosk sends (no office set → free-form punch)', async () => {
      const db = buildDb();
      const req = mkReq(db, staffUser(), {
        latitude: NEAR.lat,
        longitude: NEAR.lng,
        selfiePhoto: 'data:image/jpeg;base64,SELFIE',
        address: 'Av. Amazonas N23-45, Quito',
        battery: 87,
        checklist: ['uniforme', 'credencial'],
      });
      const res = mkRes();
      await clockIn(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db.createCalls.length, 1);
      const p = db.createCalls[0];
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.userId, USER_ID);
      assert.ok(p.punchInTime instanceof Date);
      assert.strictEqual(p.punchInLat, NEAR.lat);
      assert.strictEqual(p.punchInLng, NEAR.lng);
      assert.strictEqual(p.punchInPhoto, 'data:image/jpeg;base64,SELFIE');
      assert.strictEqual(p.punchInAddress, 'Av. Amazonas N23-45, Quito');
      assert.strictEqual(p.punchInBattery, 87);
      assert.strictEqual(p.punchInChecklist, JSON.stringify(['uniforme', 'credencial']));
      // No office configured → geofence snapshot recorded as unknown, not false.
      assert.strictEqual(p.punchInDistanceM, null);
      assert.strictEqual(p.punchInOutsideGeofence, null);
      assert.strictEqual(p.status, 'no_schedule');
      assert.strictEqual(p.lateMinutes, 0);
    });

    it('records the geofence snapshot when an office IS set and the punch is inside', async () => {
      const db = buildDb();
      const user = staffUser({
        officeLatitude: OFFICE.lat,
        officeLongitude: OFFICE.lng,
        officeGeofenceRadiusM: 150,
      });
      const res = mkRes();
      await clockIn(mkReq(db, user, { latitude: NEAR.lat, longitude: NEAR.lng }), res);

      const p = db.createCalls[0];
      assert.ok(p.punchInDistanceM != null && p.punchInDistanceM <= 150, `distance ${p.punchInDistanceM}`);
      assert.strictEqual(p.punchInOutsideGeofence, false);
    });

    it('a punch OUTSIDE the office geofence is blocked and writes NOTHING', async () => {
      const db = buildDb();
      const user = staffUser({
        officeLatitude: OFFICE.lat,
        officeLongitude: OFFICE.lng,
        officeGeofenceRadiusM: 150,
      });
      const res = mkRes();
      await clockIn(mkReq(db, user, { latitude: FAR.lat, longitude: FAR.lng }), res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error, 'geofence_failed');
      assert.strictEqual(db.createCalls.length, 0, 'blocked punch must not create a row');
    });

    it('an already-open shift is returned as-is — no duplicate row', async () => {
      const db = buildDb({
        staffShifts: [
          { id: 'ss-open', tenantId: TENANT, userId: USER_ID, punchInTime: new Date(), punchOutTime: null },
        ],
      });
      const res = mkRes();
      await clockIn(mkReq(db, staffUser(), {}), res);
      assert.strictEqual(db.createCalls.length, 0);
      assert.strictEqual(res.body.shift.id, 'ss-open');
    });

    it('a db failure is NOT swallowed into a 200 success', async () => {
      const db = buildDb();
      db.staffShift.create = async () => {
        throw new Error('ER_NO_SUCH_TABLE: staffShifts');
      };
      const res = mkRes();
      await clockIn(mkReq(db, staffUser(), { latitude: NEAR.lat, longitude: NEAR.lng }), res);
      assert.strictEqual(res.statusCode, 500, 'db error must surface as an error response');
    });
  });

  describe('clock-out — the punch-out fields + hours actually land', () => {
    it('applies every punch-out field, closes the open break, and computes net hours', async () => {
      const now = Date.now();
      const db = buildDb({
        staffShifts: [
          {
            id: 'ss-1',
            tenantId: TENANT,
            userId: USER_ID,
            punchInTime: new Date(now - 4 * 3600e3), // 4h gross
            punchOutTime: null,
            breaks: [{ start: new Date(now - 3600e3).toISOString(), end: null }], // 1h open break
          },
        ],
      });
      const res = mkRes();
      await clockOut(
        mkReq(db, staffUser(), {
          latitude: NEAR.lat,
          longitude: NEAR.lng,
          selfiePhoto: 'data:image/jpeg;base64,OUT',
          address: 'Salida oficina',
          observations: 'Cerré la caja y apagué luces',
        }),
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      const patch = db.rows[0].updateCalls[0];
      assert.ok(patch.punchOutTime instanceof Date);
      assert.strictEqual(patch.punchOutLat, NEAR.lat);
      assert.strictEqual(patch.punchOutLng, NEAR.lng);
      assert.strictEqual(patch.punchOutPhoto, 'data:image/jpeg;base64,OUT');
      assert.strictEqual(patch.punchOutAddress, 'Salida oficina');
      assert.strictEqual(patch.observations, 'Cerré la caja y apagué luces');
      // The open break got closed at punch-out time.
      assert.ok(patch.breaks[0].end, 'open break must be closed');
      // 4h gross − 1h break = 3h net (small tolerance for wall-clock drift).
      assert.ok(Math.abs(patch.hoursWorked - 3) < 0.02, `hoursWorked=${patch.hoursWorked}`);
    });

    it('a db failure on the punch-out update is NOT swallowed into a 200 success', async () => {
      const db = buildDb({
        staffShifts: [
          { id: 'ss-1', tenantId: TENANT, userId: USER_ID, punchInTime: new Date(), punchOutTime: null },
        ],
      });
      db.rows[0].update = async () => {
        throw new Error('Lock wait timeout exceeded');
      };
      const res = mkRes();
      await clockOut(mkReq(db, staffUser(), {}), res);
      assert.strictEqual(res.statusCode, 500);
    });
  });

  describe('breaks — start/end persist onto the open shift', () => {
    it('breakStart appends an open break; breakEnd closes it', async () => {
      const db = buildDb({
        staffShifts: [
          { id: 'ss-1', tenantId: TENANT, userId: USER_ID, punchInTime: new Date(), punchOutTime: null, breaks: [] },
        ],
      });

      await breakStart(mkReq(db, staffUser()), mkRes());
      let patch = db.rows[0].updateCalls[0];
      assert.strictEqual(patch.breaks.length, 1);
      assert.ok(patch.breaks[0].start);
      assert.strictEqual(patch.breaks[0].end, null);

      await breakEnd(mkReq(db, staffUser()), mkRes());
      patch = db.rows[0].updateCalls[1];
      assert.strictEqual(patch.breaks.length, 1);
      assert.ok(patch.breaks[0].end, 'break must be closed');
    });

    it('breakStart is idempotent while a break is already open (no duplicate entry)', async () => {
      const db = buildDb({
        staffShifts: [
          {
            id: 'ss-1',
            tenantId: TENANT,
            userId: USER_ID,
            punchInTime: new Date(),
            punchOutTime: null,
            breaks: [{ start: new Date().toISOString(), end: null }],
          },
        ],
      });
      await breakStart(mkReq(db, staffUser()), mkRes());
      assert.strictEqual(db.rows[0].updateCalls.length, 0, 'no write while a break is open');
    });
  });
});
