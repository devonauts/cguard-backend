/**
 * CRUD persistence tests — guardShift (GuardShiftRepository create/update/destroy).
 *
 * "Things are not being saved" regression net: every writable field the CRM
 * form can send must reach the fake db's create/update call with the right
 * value, updates must target the right row (id + tenantId in the where), and a
 * db failure must propagate (never be swallowed into a success).
 *
 * Self-contained in-memory fake db shaped like Sequelize (mirrors
 * tests/unit/attendance/attendance.test.ts). No MySQL, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g04-attendance/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import GuardShiftRepository from '../../../src/database/repositories/guardShiftRepository';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-admin-1';

/** Admin member of TENANT — passes the repository's isAdmin ACL branch. */
const ADMIN_USER = {
  id: USER_ID,
  email: 'admin@test.dev',
  emailVerified: true,
  tenants: [
    { tenant: { id: TENANT }, status: 'active', roles: ['admin'] },
  ],
};

// ── Sequelize-shaped fake row / db ───────────────────────────────────────────
function makeGsRow(data: any) {
  const row: any = {
    ...data,
    updateCalls: [] as any[],
    destroyed: false,
    patrolsDoneSet: null as any,
    dailyIncidentsSet: null as any,
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
    async destroy() {
      row.destroyed = true;
    },
    async setPatrolsDone(ids: any) {
      row.patrolsDoneSet = ids;
    },
    async setDailyIncidents(ids: any) {
      row.dailyIncidentsSet = ids;
    },
    async getPatrolsDone() {
      return [];
    },
    async getDailyIncidents() {
      return [];
    },
  };
  return row;
}

function buildDb(seed: { guardShifts?: any[] } = {}) {
  const rows = (seed.guardShifts || []).map(makeGsRow);
  const createCalls: any[] = [];
  const findOneCalls: any[] = [];
  const audits: any[] = [];

  const db: any = {
    rows,
    createCalls,
    findOneCalls,
    audits,
    // Referenced only inside `include` arrays — never called.
    station: {},
    securityGuard: {},
    inventoryHistory: {},
    tenantUser: { async findOne() { return null; } },
    businessInfo: { async findAll() { return []; } },
    guardShift: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeGsRow({ id: `gs-new-${createCalls.length}`, ...payload });
        rows.push(row);
        return row;
      },
      async findOne({ where }: any) {
        findOneCalls.push({ ...where });
        return (
          rows.find(
            (r: any) =>
              (where.id === undefined || r.id === where.id) &&
              (where.tenantId === undefined || r.tenantId === where.tenantId),
          ) || null
        );
      },
    },
    auditLog: {
      async create(entry: any) {
        audits.push(entry);
        return makeGsRow({ id: `audit-${audits.length}`, ...entry });
      },
    },
  };
  return db;
}

function options(db: any) {
  return {
    language: 'en',
    currentUser: ADMIN_USER,
    currentTenant: { id: TENANT },
    database: db,
  } as any;
}

/** Every writable field of the guardShift create/edit form. */
function fullPayload() {
  return {
    punchInTime: new Date('2026-07-01T08:00:00Z'),
    punchInLatitude: -0.180653,
    punchInLongitude: -78.467838,
    shiftSchedule: 'Diurno',
    numberOfPatrolsDuringShift: 4,
    numberOfIncidentsDurindShift: 2,
    observations: 'Sin novedad en el puesto',
    punchOutTime: new Date('2026-07-01T16:00:00Z'),
    punchOutLatitude: -0.180700,
    punchOutLongitude: -78.467900,
    importHash: 'hash-abc-123',
    // Association ids the way the frontend/service sends them:
    stationName: 'st-1',
    guardName: 'sg-1',
    completeInventoryCheck: 'inv-1',
    postSite: 'ps-1',
    patrolsDone: ['pl-1', 'pl-2'],
    dailyIncidents: ['inc-1'],
  };
}

describe('crud-g04 · guardShift repository', () => {
  describe('create — field fidelity', () => {
    it('persists EVERY writable field with the exact value the caller sent', async () => {
      const db = buildDb();
      const data = fullPayload();

      await GuardShiftRepository.create(data, options(db));

      assert.strictEqual(db.createCalls.length, 1, 'exactly one INSERT');
      const p = db.createCalls[0];

      // Scalar fields — value-for-value.
      assert.strictEqual(p.punchInTime, data.punchInTime);
      assert.strictEqual(p.punchInLatitude, data.punchInLatitude);
      assert.strictEqual(p.punchInLongitude, data.punchInLongitude);
      assert.strictEqual(p.shiftSchedule, 'Diurno');
      assert.strictEqual(p.numberOfPatrolsDuringShift, 4);
      assert.strictEqual(p.numberOfIncidentsDurindShift, 2);
      assert.strictEqual(p.observations, 'Sin novedad en el puesto');
      assert.strictEqual(p.punchOutTime, data.punchOutTime);
      assert.strictEqual(p.punchOutLatitude, data.punchOutLatitude);
      assert.strictEqual(p.punchOutLongitude, data.punchOutLongitude);
      assert.strictEqual(p.importHash, 'hash-abc-123');

      // Association field name mapping (frontend name → FK column).
      assert.strictEqual(p.stationNameId, 'st-1');
      assert.strictEqual(p.guardNameId, 'sg-1');
      assert.strictEqual(p.completeInventoryCheckId, 'inv-1');
      assert.strictEqual(p.postSiteId, 'ps-1');

      // Ownership stamps.
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);
    });

    it('persists the many-to-many links (patrolsDone / dailyIncidents) on the new row', async () => {
      const db = buildDb();
      await GuardShiftRepository.create(fullPayload(), options(db));
      const row = db.rows[0];
      assert.deepStrictEqual(row.patrolsDoneSet, ['pl-1', 'pl-2']);
      assert.deepStrictEqual(row.dailyIncidentsSet, ['inc-1']);
    });

    it('accepts postSiteId directly when postSite is not sent', async () => {
      const db = buildDb();
      const data: any = fullPayload();
      delete data.postSite;
      data.postSiteId = 'ps-direct';
      await GuardShiftRepository.create(data, options(db));
      assert.strictEqual(db.createCalls[0].postSiteId, 'ps-direct');
    });

    it('does NOT swallow a db failure into a success (INSERT error propagates)', async () => {
      const db = buildDb();
      db.guardShift.create = async () => {
        throw new Error('ER_NO_SUCH_TABLE: guardShifts');
      };
      await assert.rejects(
        () => GuardShiftRepository.create(fullPayload(), options(db)),
        /ER_NO_SUCH_TABLE/,
      );
      assert.strictEqual(db.audits.length, 0, 'no audit log on a failed write');
    });
  });

  describe('update — targets the right row and applies the whole patch', () => {
    function seedRow(overrides: any = {}) {
      return {
        id: 'gs-1',
        tenantId: TENANT,
        punchInTime: new Date('2026-07-01T08:00:00Z'),
        shiftSchedule: 'Diurno',
        numberOfPatrolsDuringShift: 1,
        numberOfIncidentsDurindShift: 0,
        observations: 'original',
        stationNameId: 'st-1',
        guardNameId: 'sg-1',
        completeInventoryCheckId: 'inv-1',
        postSiteId: 'ps-1',
        ...overrides,
      };
    }

    it('looks the row up by id AND tenantId (tenant-scoped where)', async () => {
      const db = buildDb({ guardShifts: [seedRow()] });
      await GuardShiftRepository.update('gs-1', fullPayload(), options(db));
      const where = db.findOneCalls[0];
      assert.strictEqual(where.id, 'gs-1');
      assert.strictEqual(where.tenantId, TENANT);
    });

    it('applies EVERY writable field of the patch to the row', async () => {
      const db = buildDb({ guardShifts: [seedRow()] });
      const data = fullPayload();
      data.observations = 'observaciones EDITADAS';
      data.shiftSchedule = 'Nocturno';
      data.numberOfPatrolsDuringShift = 9;
      data.numberOfIncidentsDurindShift = 5;

      await GuardShiftRepository.update('gs-1', data, options(db));

      const row = db.rows[0];
      assert.strictEqual(row.updateCalls.length, 1);
      const patch = row.updateCalls[0];
      assert.strictEqual(patch.observations, 'observaciones EDITADAS');
      assert.strictEqual(patch.shiftSchedule, 'Nocturno');
      assert.strictEqual(patch.numberOfPatrolsDuringShift, 9);
      assert.strictEqual(patch.numberOfIncidentsDurindShift, 5);
      assert.strictEqual(patch.punchInTime, data.punchInTime);
      assert.strictEqual(patch.punchOutTime, data.punchOutTime);
      assert.strictEqual(patch.punchInLatitude, data.punchInLatitude);
      assert.strictEqual(patch.punchInLongitude, data.punchInLongitude);
      assert.strictEqual(patch.punchOutLatitude, data.punchOutLatitude);
      assert.strictEqual(patch.punchOutLongitude, data.punchOutLongitude);
      assert.strictEqual(patch.stationNameId, 'st-1');
      assert.strictEqual(patch.guardNameId, 'sg-1');
      assert.strictEqual(patch.completeInventoryCheckId, 'inv-1');
      assert.strictEqual(patch.postSiteId, 'ps-1');
      assert.strictEqual(patch.updatedById, USER_ID);
      // …and the row actually carries the new values afterwards.
      assert.strictEqual(row.observations, 'observaciones EDITADAS');
      assert.deepStrictEqual(row.patrolsDoneSet, ['pl-1', 'pl-2']);
      assert.deepStrictEqual(row.dailyIncidentsSet, ['inc-1']);
    });

    it('404s (does not silently no-op) when the id belongs to ANOTHER tenant', async () => {
      const db = buildDb({ guardShifts: [seedRow({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => GuardShiftRepository.update('gs-1', fullPayload(), options(db)),
        Error404,
      );
      assert.strictEqual(db.rows[0].updateCalls.length, 0, 'foreign row must not be touched');
    });

    // FIXED: GuardShiftRepository.update now presence-guards the association
    // FK mapping (stationName/guardName/completeInventoryCheck/postSite →
    // `data.X !== undefined ? (data.X || null) : undefined`) and only re-sets
    // patrolsDone/dailyIncidents when the payload carries them, so a partial
    // patch no longer wipes links/associations.
    it('a partial patch (observations only) must NOT wipe the station/guard links', async () => {
      const db = buildDb({ guardShifts: [seedRow()] });
      await GuardShiftRepository.update('gs-1', { observations: 'solo texto' }, options(db));
      const patch = db.rows[0].updateCalls[0];
      assert.notStrictEqual(patch.stationNameId, null, 'stationNameId wiped by partial update');
      assert.notStrictEqual(patch.guardNameId, null, 'guardNameId wiped by partial update');
      assert.notStrictEqual(patch.completeInventoryCheckId, null, 'completeInventoryCheckId wiped by partial update');
      assert.notStrictEqual(patch.postSiteId, null, 'postSiteId wiped by partial update');
      // The many-to-many links must not be re-set (i.e. deleted) either.
      assert.strictEqual(db.rows[0].patrolsDoneSet, null, 'patrolsDone associations wiped by partial update');
      assert.strictEqual(db.rows[0].dailyIncidentsSet, null, 'dailyIncidents associations wiped by partial update');
    });

    it('does NOT swallow a db failure on update (error propagates)', async () => {
      const db = buildDb({ guardShifts: [seedRow()] });
      db.rows[0].update = async () => {
        throw new Error('Lock wait timeout exceeded');
      };
      await assert.rejects(
        () => GuardShiftRepository.update('gs-1', fullPayload(), options(db)),
        /Lock wait timeout/,
      );
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row', async () => {
      const db = buildDb({ guardShifts: [{ id: 'gs-1', tenantId: TENANT }] });
      await GuardShiftRepository.destroy('gs-1', options(db));
      assert.strictEqual(db.rows[0].destroyed, true);
      assert.strictEqual(db.findOneCalls[0].tenantId, TENANT);
    });

    it('404s for a row of another tenant instead of deleting it', async () => {
      const db = buildDb({ guardShifts: [{ id: 'gs-1', tenantId: OTHER_TENANT }] });
      await assert.rejects(() => GuardShiftRepository.destroy('gs-1', options(db)), Error404);
      assert.strictEqual(db.rows[0].destroyed, false);
    });
  });
});
