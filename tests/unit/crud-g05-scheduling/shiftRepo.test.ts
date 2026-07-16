/**
 * CRUD persistence tests — shift (ShiftRepository create/update/destroy).
 *
 * "Things are not being saved" regression net for the Programador/turnos core:
 * every writable field the CRM shift form can send must reach the fake db's
 * create/update call with the right value, updates must target the right row
 * (id + tenantId in the where), partial updates must NOT wipe the station/guard
 * links, and a db failure must propagate (never be swallowed into a success).
 *
 * Self-contained in-memory fake db shaped like Sequelize (mirrors
 * tests/unit/attendance/attendance.test.ts). No MySQL, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g05-scheduling/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import ShiftRepository from '../../../src/database/repositories/shiftRepository';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-admin-1';

const ADMIN_USER = {
  id: USER_ID,
  email: 'admin@test.dev',
  emailVerified: true,
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

// ── Sequelize-shaped fake row / db ───────────────────────────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    _updates: [] as any[],
    _destroyed: false,
    get(opts?: any) {
      void opts;
      return { ...data };
    },
    async update(patch: any) {
      row._updates.push({ ...patch });
      // Mirror Sequelize semantics: keys with value `undefined` are SKIPPED by
      // instance.set(), so a presence-guarded repo patch leaves them untouched.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        data[k] = v;
        row[k] = v;
      }
      return row;
    },
    async destroy() {
      row._destroyed = true;
    },
  };
  return row;
}

function buildDb(seed: { shifts?: any[] } = {}) {
  const rows = (seed.shifts || []).map(makeRow);
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
    user: {},
    tenantUser: {},
    shift: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeRow({ id: `sh-new-${createCalls.length}`, ...payload });
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
        return makeRow({ id: `audit-${audits.length}`, ...entry });
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

/** Every writable field the CRM/scheduler can send for a shift. */
function fullPayload() {
  return {
    startTime: new Date('2026-08-01T07:00:00Z'),
    endTime: new Date('2026-08-01T19:00:00Z'),
    importHash: 'imp-hash-1',
    // Association ids the way the service/frontend sends them:
    station: 'st-1',
    guard: 'user-g1',
    postSite: 'ps-1',
    tenantUserId: 'tu-1',
    // JSON payload fields (worker-app shift to-dos etc.):
    siteTours: [{ id: 'tour-1', name: 'Ronda perimetral' }],
    tasks: [{ id: 'task-1', label: 'Revisar bodega' }],
    postOrders: [{ id: 'po-1', title: 'Consigna nocturna' }],
    checklists: [{ id: 'cl-1', items: ['linterna'] }],
    skillSet: ['armado', 'primeros auxilios'],
    department: 'Operaciones',
  };
}

describe('crud-g05 · shift repository', () => {
  describe('create — field fidelity', () => {
    it('persists EVERY writable field with the exact value the caller sent', async () => {
      const db = buildDb();
      const data = fullPayload();

      await ShiftRepository.create(data, options(db));

      assert.strictEqual(db.createCalls.length, 1, 'exactly one INSERT');
      const p = db.createCalls[0];

      assert.strictEqual(p.startTime, data.startTime);
      assert.strictEqual(p.endTime, data.endTime);
      assert.strictEqual(p.importHash, 'imp-hash-1');
      assert.strictEqual(p.department, 'Operaciones');
      assert.deepStrictEqual(p.siteTours, data.siteTours);
      assert.deepStrictEqual(p.tasks, data.tasks);
      assert.deepStrictEqual(p.postOrders, data.postOrders);
      assert.deepStrictEqual(p.checklists, data.checklists);
      assert.deepStrictEqual(p.skillSet, data.skillSet);

      // Association name mapping (frontend name → FK column).
      assert.strictEqual(p.stationId, 'st-1');
      assert.strictEqual(p.guardId, 'user-g1');
      assert.strictEqual(p.postSiteId, 'ps-1');
      assert.strictEqual(p.tenantUserId, 'tu-1');

      // Ownership stamps.
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);

      // Audit trail written.
      assert.strictEqual(db.audits.length, 1);
      assert.strictEqual(db.audits[0].action, 'create');
      assert.strictEqual(db.audits[0].entityName, 'shift');
    });

    it('accepts the snake_case aliases the API also documents (tenant_user_id, site_tours, post_orders, skill_set)', async () => {
      const db = buildDb();
      const data: any = {
        startTime: new Date('2026-08-02T07:00:00Z'),
        endTime: new Date('2026-08-02T19:00:00Z'),
        station: 'st-1',
        guard: 'user-g1',
        tenant_user_id: 'tu-snake',
        site_tours: [{ id: 'tour-s' }],
        post_orders: [{ id: 'po-s' }],
        skill_set: ['radio'],
      };
      await ShiftRepository.create(data, options(db));
      const p = db.createCalls[0];
      assert.strictEqual(p.tenantUserId, 'tu-snake');
      assert.deepStrictEqual(p.siteTours, [{ id: 'tour-s' }]);
      assert.deepStrictEqual(p.postOrders, [{ id: 'po-s' }]);
      assert.deepStrictEqual(p.skillSet, ['radio']);
    });

    it('does NOT swallow a db failure into a success (INSERT error propagates)', async () => {
      const db = buildDb();
      db.shift.create = async () => {
        throw new Error('ER_NO_SUCH_TABLE: shifts');
      };
      await assert.rejects(
        () => ShiftRepository.create(fullPayload(), options(db)),
        /ER_NO_SUCH_TABLE/,
      );
      assert.strictEqual(db.audits.length, 0, 'no audit log on a failed write');
    });
  });

  describe('update — targets the right row and applies the whole patch', () => {
    function seedRow(overrides: any = {}) {
      return {
        id: 'sh-1',
        tenantId: TENANT,
        startTime: new Date('2026-08-01T07:00:00Z'),
        endTime: new Date('2026-08-01T19:00:00Z'),
        stationId: 'st-1',
        guardId: 'user-g1',
        postSiteId: 'ps-1',
        tenantUserId: 'tu-1',
        siteTours: [{ id: 'tour-1' }],
        tasks: [{ id: 'task-1' }],
        postOrders: [{ id: 'po-1' }],
        checklists: [{ id: 'cl-1' }],
        skillSet: ['armado'],
        department: 'Operaciones',
        importHash: 'orig-hash',
        ...overrides,
      };
    }

    it('looks the row up by id AND tenantId (tenant-scoped where)', async () => {
      const db = buildDb({ shifts: [seedRow()] });
      await ShiftRepository.update('sh-1', fullPayload(), options(db));
      const where = db.findOneCalls[0];
      assert.strictEqual(where.id, 'sh-1');
      assert.strictEqual(where.tenantId, TENANT);
    });

    it('applies EVERY writable field of the patch to the row', async () => {
      const db = buildDb({ shifts: [seedRow()] });
      const data: any = fullPayload();
      data.startTime = new Date('2026-08-03T06:00:00Z');
      data.endTime = new Date('2026-08-03T18:00:00Z');
      data.station = 'st-2';
      data.guard = 'user-g2';
      data.postSite = 'ps-2';
      data.tenantUserId = 'tu-2';
      data.department = 'Nocturno';
      data.tasks = [{ id: 'task-2', label: 'Nueva tarea' }];
      data.checklists = [{ id: 'cl-2' }];

      await ShiftRepository.update('sh-1', data, options(db));

      const row = db.rows[0];
      assert.strictEqual(row._updates.length, 1);
      const patch = row._updates[0];
      assert.strictEqual(patch.startTime, data.startTime);
      assert.strictEqual(patch.endTime, data.endTime);
      assert.strictEqual(patch.stationId, 'st-2');
      assert.strictEqual(patch.guardId, 'user-g2');
      assert.strictEqual(patch.postSiteId, 'ps-2');
      assert.strictEqual(patch.tenantUserId, 'tu-2');
      assert.strictEqual(patch.department, 'Nocturno');
      assert.deepStrictEqual(patch.tasks, data.tasks);
      assert.deepStrictEqual(patch.checklists, data.checklists);
      assert.deepStrictEqual(patch.siteTours, data.siteTours);
      assert.deepStrictEqual(patch.postOrders, data.postOrders);
      assert.deepStrictEqual(patch.skillSet, data.skillSet);
      assert.strictEqual(patch.updatedById, USER_ID);
      // …and the row actually carries the new values afterwards.
      assert.strictEqual(row.stationId, 'st-2');
      assert.strictEqual(row.guardId, 'user-g2');
      assert.strictEqual(row.department, 'Nocturno');
    });

    it('a PARTIAL patch (times only) must NOT wipe the station/guard/postSite links nor the JSON blobs', async () => {
      const db = buildDb({ shifts: [seedRow()] });
      const newStart = new Date('2026-08-04T07:00:00Z');
      await ShiftRepository.update('sh-1', { startTime: newStart }, options(db));

      const row = db.rows[0];
      // Presence-guarded mapping: absent keys land as `undefined` (skipped by
      // Sequelize), so the stored links survive a partial edit.
      assert.strictEqual(row.startTime, newStart);
      assert.strictEqual(row.stationId, 'st-1', 'stationId must survive a partial update');
      assert.strictEqual(row.guardId, 'user-g1', 'guardId must survive a partial update');
      assert.strictEqual(row.postSiteId, 'ps-1', 'postSiteId must survive a partial update');
      assert.strictEqual(row.tenantUserId, 'tu-1', 'tenantUserId must survive a partial update');
      assert.deepStrictEqual(row.siteTours, [{ id: 'tour-1' }]);
      assert.deepStrictEqual(row.tasks, [{ id: 'task-1' }]);
      assert.deepStrictEqual(row.postOrders, [{ id: 'po-1' }]);
      assert.deepStrictEqual(row.checklists, [{ id: 'cl-1' }]);
      assert.deepStrictEqual(row.skillSet, ['armado']);
      assert.strictEqual(row.department, 'Operaciones');
    });

    it('an EXPLICIT clear (station:null / guard:null) IS persisted as null (unassign works)', async () => {
      const db = buildDb({ shifts: [seedRow()] });
      await ShiftRepository.update('sh-1', { station: null, guard: null }, options(db));
      const row = db.rows[0];
      assert.strictEqual(row.stationId, null, 'explicit station clear must persist');
      assert.strictEqual(row.guardId, null, 'explicit guard clear must persist');
    });

    it('404s (does not silently no-op) when the id belongs to ANOTHER tenant', async () => {
      const db = buildDb({ shifts: [seedRow({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => ShiftRepository.update('sh-1', fullPayload(), options(db)),
        Error404,
      );
      assert.strictEqual(db.rows[0]._updates.length, 0, 'foreign row must not be touched');
    });

    it('does NOT swallow a db failure on update (error propagates)', async () => {
      const db = buildDb({ shifts: [seedRow()] });
      db.rows[0].update = async () => {
        throw new Error('Lock wait timeout exceeded');
      };
      await assert.rejects(
        () => ShiftRepository.update('sh-1', fullPayload(), options(db)),
        /Lock wait timeout/,
      );
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row and writes the audit', async () => {
      const db = buildDb({ shifts: [{ id: 'sh-1', tenantId: TENANT }] });
      await ShiftRepository.destroy('sh-1', options(db));
      assert.strictEqual(db.rows[0]._destroyed, true);
      assert.strictEqual(db.findOneCalls[0].tenantId, TENANT);
      assert.strictEqual(db.audits.length, 1);
      assert.strictEqual(db.audits[0].action, 'delete');
    });

    it('404s for a row of another tenant instead of deleting it', async () => {
      const db = buildDb({ shifts: [{ id: 'sh-1', tenantId: OTHER_TENANT }] });
      await assert.rejects(() => ShiftRepository.destroy('sh-1', options(db)), Error404);
      assert.strictEqual(db.rows[0]._destroyed, false);
    });
  });
});
