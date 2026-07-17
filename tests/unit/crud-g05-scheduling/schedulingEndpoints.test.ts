/**
 * CRUD persistence tests — scheduling engine write paths:
 *
 *   · stationPositionCreate / stationPositionUpdate  (turnos of a station)
 *   · rotationStyleCreate                            (rotation patterns)
 *   · scheduleOverrideCreate                         (V/PM/F/L day overrides)
 *   · assignmentService.createAssignment             (guard ↔ station, THE write path)
 *
 * Handler-level tests use a fake req/res (superadmin user → PermissionChecker
 * passes) so they exercise the WRITE logic, not the ACL. Fake db is
 * Sequelize-shaped and records every create/update call. No MySQL, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g05-scheduling/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import {
  stationPositionCreate,
  stationPositionUpdate,
  rotationStyleCreate,
  scheduleOverrideCreate,
} from '../../../src/api/scheduling/schedulingEndpoints';
import {
  createAssignment,
  AssignmentValidationError,
} from '../../../src/services/assignmentService';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-admin-1';

const ADMIN_USER = {
  id: USER_ID,
  email: 'admin@test.dev',
  fullName: 'Admin Uno',
  emailVerified: true,
  isSuperadmin: true,
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

// ── Sequelize-shaped fakes ───────────────────────────────────────────────────
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
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue; // Sequelize skips undefined keys
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

/** Plain-field where matcher (symbols/ops are treated as pass-through). */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    const v = where[key];
    if (v === null) {
      if (row[key] !== null && row[key] !== undefined) return false;
      continue;
    }
    if (Array.isArray(v)) {
      if (!v.includes(row[key])) return false;
      continue;
    }
    if (typeof v === 'object') continue; // Op.* condition — pass
    if (row[key] !== v) return false;
  }
  return true;
}

function makeModel(name: string) {
  let seq = 0;
  const model: any = {
    name,
    rows: [] as any[],
    calls: { create: [] as any[], findOne: [] as any[], findOrCreate: [] as any[], destroy: [] as any[], update: [] as any[] },
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${++seq}`, ...data });
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q.where || {});
      return model.rows.find((r: any) => matchWhere(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      return model.rows.filter((r: any) => matchWhere(r, q.where));
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id) || null;
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => matchWhere(r, q.where)).length;
    },
    async findOrCreate({ where, defaults }: any) {
      model.calls.findOrCreate.push({ where: { ...where }, defaults: { ...defaults } });
      const existing = model.rows.find((r: any) => matchWhere(r, where));
      if (existing) return [existing, false];
      const row = await model.create({ ...where, ...defaults });
      return [row, true];
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q.where || {});
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      victims.forEach((r: any) => (r._destroyed = true));
      return victims.length;
    },
    async update(patch: any, q: any = {}) {
      model.calls.update.push({ patch: { ...patch }, where: q.where || {} });
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      for (const r of victims) await r.update(patch);
      return [victims.length];
    },
    async bulkCreate(rows: any[]) {
      return rows.map((r) => {
        model.calls.create.push({ ...r });
        const row = makeRow({ id: `${name}-${++seq}`, ...r });
        model.rows.push(row);
        return row;
      });
    },
  };
  return model;
}

function buildDb() {
  const db: any = {
    Sequelize: require('sequelize'),
    stationPosition: makeModel('stationPosition'),
    rotationStyle: makeModel('rotationStyle'),
    scheduleOverride: makeModel('scheduleOverride'),
    guardAssignment: makeModel('guardAssignment'),
    station: makeModel('station'),
    shift: makeModel('shift'),
    tenant: makeModel('tenant'),
    tenantUser: makeModel('tenantUser'),
    securityGuard: makeModel('securityGuard'),
    user: makeModel('user'),
    businessInfo: makeModel('businessInfo'),
  };
  return db;
}

function makeReq(db: any, extra: any = {}) {
  return {
    database: db,
    currentTenant: { id: TENANT },
    currentUser: ADMIN_USER,
    language: 'en',
    params: {},
    query: {},
    body: {},
    ...extra,
  };
}

function makeRes() {
  const r: any = {
    statusCode: null as number | null,
    body: undefined as any,
    status(c: number) { r.statusCode = c; return r; },
    send(p?: any) { if (r.statusCode == null) r.statusCode = 200; r.body = p; return r; },
    json(p?: any) { if (r.statusCode == null) r.statusCode = 200; r.body = p; return r; },
    sendStatus(c: number) { r.statusCode = c; return r; },
    header() { return r; },
  };
  return r;
}

// ═════════════════════════ stationPosition (turnos) ══════════════════════════

describe('crud-g05 · stationPosition handlers', () => {
  it('create persists EVERY field (name/type/times/guardsNeeded/sortOrder) + station/tenant/user stamps', async () => {
    const db = buildDb();
    const req = makeReq(db, {
      params: { stationId: 'st-1' },
      body: {
        data: {
          name: 'Sacafranco Nocturno',
          type: 'sacafranco',
          startTime: '19:00',
          endTime: '07:00',
          guardsNeeded: '3',
          sortOrder: '2',
        },
      },
    });
    const res = makeRes();
    await stationPositionCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.stationPosition.calls.create.length, 1, 'exactly one INSERT');
    const p = db.stationPosition.calls.create[0];
    assert.strictEqual(p.name, 'Sacafranco Nocturno');
    assert.strictEqual(p.type, 'sacafranco');
    assert.strictEqual(p.startTime, '19:00');
    assert.strictEqual(p.endTime, '07:00');
    assert.strictEqual(p.guardsNeeded, 3, 'string "3" must be persisted as the number 3');
    assert.strictEqual(p.sortOrder, 2);
    assert.strictEqual(p.stationId, 'st-1');
    assert.strictEqual(p.tenantId, TENANT);
    assert.strictEqual(p.createdById, USER_ID);
    assert.strictEqual(p.updatedById, USER_ID);
  });

  it('update targets {id, tenantId} and applies exactly the sent fields (absent keys untouched)', async () => {
    const db = buildDb();
    db.stationPosition.rows.push(makeRow({
      id: 'pos-1', tenantId: TENANT, stationId: 'st-1',
      name: 'Fijo 1', type: 'fijo', startTime: '07:00', endTime: '19:00',
      guardsNeeded: 1, sortOrder: 0,
    }));

    const req = makeReq(db, {
      params: { positionId: 'pos-1' },
      body: { data: { name: 'Fijo 1 (día)', startTime: '06:00', guardsNeeded: 2, sortOrder: 0 } },
    });
    const res = makeRes();
    await stationPositionUpdate(req, res);

    assert.strictEqual(res.statusCode, 200);
    const where = db.stationPosition.calls.findOne[0];
    assert.strictEqual(where.id, 'pos-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.stationPosition.rows[0];
    assert.strictEqual(row._updates.length, 1);
    const patch = row._updates[0];
    assert.strictEqual(patch.name, 'Fijo 1 (día)');
    assert.strictEqual(patch.startTime, '06:00');
    assert.strictEqual(patch.guardsNeeded, 2);
    assert.strictEqual(patch.sortOrder, 0, 'an explicit sortOrder of 0 must be applied, not dropped');
    assert.strictEqual(patch.updatedById, USER_ID);
    // Absent keys must not appear in the patch at all (no wipe).
    assert.ok(!('endTime' in patch), 'absent endTime must not be in the patch');
    assert.ok(!('type' in patch), 'absent type must not be in the patch');
    assert.strictEqual(row.endTime, '19:00', 'stored endTime survives');
    assert.strictEqual(row.type, 'fijo', 'stored type survives');
  });

  it('update 404s (and touches nothing) for a position of ANOTHER tenant', async () => {
    const db = buildDb();
    db.stationPosition.rows.push(makeRow({
      id: 'pos-1', tenantId: OTHER_TENANT, stationId: 'st-1',
      name: 'Fijo 1', type: 'fijo', startTime: '07:00', endTime: '19:00',
    }));
    const req = makeReq(db, { params: { positionId: 'pos-1' }, body: { data: { name: 'hack' } } });
    const res = makeRes();
    await stationPositionUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.stationPosition.rows[0]._updates.length, 0);
  });

  it('create does NOT swallow a db failure into a 200', async () => {
    const db = buildDb();
    db.stationPosition.create = async () => {
      throw new Error('ER_NO_SUCH_TABLE: stationPositions');
    };
    const req = makeReq(db, { params: { stationId: 'st-1' }, body: { data: { name: 'X' } } });
    const res = makeRes();
    await stationPositionCreate(req, res);
    assert.notStrictEqual(res.statusCode, 200, 'db failure must not produce a success response');
  });
});

// ═════════════════════════ rotationStyle ═════════════════════════════════════

describe('crud-g05 · rotationStyleCreate handler', () => {
  it('persists name/description and numeric day/night/rest counts', async () => {
    const db = buildDb();
    const req = makeReq(db, {
      body: { data: { name: '4-4-2', description: 'Cuatro días, cuatro noches, dos libres', dayShifts: '4', nightShifts: '4', restDays: '2' } },
    });
    const res = makeRes();
    await rotationStyleCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    const p = db.rotationStyle.calls.create[0];
    assert.strictEqual(p.name, '4-4-2');
    assert.strictEqual(p.description, 'Cuatro días, cuatro noches, dos libres');
    assert.strictEqual(p.dayShifts, 4);
    assert.strictEqual(p.nightShifts, 4);
    assert.strictEqual(p.restDays, 2);
    assert.strictEqual(p.isSystem, false);
    assert.strictEqual(p.tenantId, TENANT);
    assert.strictEqual(p.createdById, USER_ID);
    assert.strictEqual(p.updatedById, USER_ID);
  });

  // FIXED: rotationStyleCreate now NaN-guards the counts instead of `|| default`,
  // so an explicit 0 (night-only / no-rest rotation) persists as 0.
  it('an EXPLICIT dayShifts of 0 (night-only rotation) is persisted as 0, not the default 5', async () => {
    const db = buildDb();
    const req = makeReq(db, {
      body: { data: { name: 'Nocturno 4-2', dayShifts: 0, nightShifts: '4', restDays: '2' } },
    });
    const res = makeRes();
    await rotationStyleCreate(req, res);
    const p = db.rotationStyle.calls.create[0];
    assert.strictEqual(p.dayShifts, 0, 'explicit 0 dayShifts must persist (night-only rotation)');
  });
});

// ═════════════════════════ scheduleOverride (V/PM/F/L) ═══════════════════════

describe('crud-g05 · scheduleOverrideCreate handler', () => {
  it('creates the override with every field (guard/assignment/date/type/note/tenant/createdBy)', async () => {
    const db = buildDb();
    const req = makeReq(db, {
      body: { data: { guardId: 'user-g1', assignmentId: 'ga-1', date: '2026-07-20', type: 'D', note: 'Cubre feriado' } },
    });
    const res = makeRes();
    await scheduleOverrideCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.scheduleOverride.calls.findOrCreate.length, 1);
    const { where, defaults } = db.scheduleOverride.calls.findOrCreate[0];
    assert.deepStrictEqual(where, { guardId: 'user-g1', date: '2026-07-20', tenantId: TENANT });
    assert.strictEqual(defaults.guardId, 'user-g1');
    assert.strictEqual(defaults.assignmentId, 'ga-1');
    assert.strictEqual(defaults.date, '2026-07-20');
    assert.strictEqual(defaults.type, 'D');
    assert.strictEqual(defaults.note, 'Cubre feriado');
    assert.strictEqual(defaults.tenantId, TENANT);
    assert.strictEqual(defaults.createdById, USER_ID);
  });

  it('UPSERTS: a second override for the same guard+date updates type/note instead of duplicating', async () => {
    const db = buildDb();
    db.scheduleOverride.rows.push(makeRow({
      id: 'ov-1', tenantId: TENANT, guardId: 'user-g1', date: '2026-07-20', type: 'D', note: 'original',
    }));
    const req = makeReq(db, {
      body: { data: { guardId: 'user-g1', date: '2026-07-20', type: 'N', note: 'cambiado a noche', assignmentId: 'ga-2' } },
    });
    const res = makeRes();
    await scheduleOverrideCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    const row = db.scheduleOverride.rows[0];
    assert.strictEqual(row._updates.length, 1);
    assert.strictEqual(row.type, 'N');
    assert.strictEqual(row.note, 'cambiado a noche');
    assert.strictEqual(row.assignmentId, 'ga-2');
    assert.strictEqual(db.scheduleOverride.rows.length, 1, 'no duplicate row');
  });

  it('an ABSENCE override (V) also removes the guard\'s shift on that local day', async () => {
    const db = buildDb();
    db.tenant.rows.push(makeRow({ id: TENANT, timezone: 'UTC' }));
    db.shift.rows.push(makeRow({ id: 'sh-on-day', tenantId: TENANT, guardId: 'user-g1', startTime: '2026-07-20T07:00:00Z' }));
    db.shift.rows.push(makeRow({ id: 'sh-other-day', tenantId: TENANT, guardId: 'user-g1', startTime: '2026-07-21T07:00:00Z' }));

    const req = makeReq(db, {
      body: { data: { guardId: 'user-g1', date: '2026-07-20', type: 'V', note: 'Vacaciones' } },
    });
    const res = makeRes();
    await scheduleOverrideCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.shift.calls.destroy.length, 1, 'the day\'s shift must be destroyed');
    assert.deepStrictEqual(db.shift.calls.destroy[0].id, ['sh-on-day'], 'ONLY the shift on the override date is removed');
  });

  it('rejects a missing type/guardId/date with a 400 (not a silent 200)', async () => {
    const db = buildDb();
    const req = makeReq(db, { body: { data: { guardId: 'user-g1', date: '2026-07-20' } } });
    const res = makeRes();
    await scheduleOverrideCreate(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.scheduleOverride.calls.findOrCreate.length, 0, 'nothing written');
  });

  it('rejects an unknown type value with a 400', async () => {
    const db = buildDb();
    const req = makeReq(db, { body: { data: { guardId: 'user-g1', date: '2026-07-20', type: 'ZZ' } } });
    const res = makeRes();
    await scheduleOverrideCreate(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
});

// ═════════════════════ createAssignment (assignmentService) ══════════════════

describe('crud-g05 · assignmentService.createAssignment', () => {
  function buildAssignDb() {
    const db = buildDb();
    // guard 'user-g1' is a member of the tenant → resolveGuardUserId resolves it.
    db.tenantUser.rows.push(makeRow({ id: 'tu-1', tenantId: TENANT, userId: 'user-g1' }));
    return db;
  }

  it('ADHOC: persists every field (guard/station/kind/dates/times/platoon/isRelief/status/stamps)', async () => {
    const db = buildAssignDb();
    const record = await createAssignment(db, TENANT, USER_ID, {
      guardId: 'user-g1',
      stationId: 'st-1',
      startDate: '2026-07-20',
      endDate: '2026-07-25',
      startTime: '08:00',
      endTime: '16:00',
      isRelief: false,
    });

    assert.ok(record);
    assert.strictEqual(db.guardAssignment.calls.create.length, 1, 'exactly one INSERT');
    const p = db.guardAssignment.calls.create[0];
    assert.strictEqual(p.guardId, 'user-g1', 'resolved user id must be stored');
    assert.strictEqual(p.stationId, 'st-1');
    assert.strictEqual(p.kind, 'adhoc');
    assert.strictEqual(p.positionId, null);
    assert.strictEqual(p.startDate, '2026-07-20');
    assert.strictEqual(p.endDate, '2026-07-25');
    assert.strictEqual(p.startTime, '08:00');
    assert.strictEqual(p.endTime, '16:00');
    assert.strictEqual(p.platoonOffset, 0);
    assert.strictEqual(p.isRelief, false);
    assert.strictEqual(p.status, 'active');
    assert.strictEqual(p.tenantId, TENANT);
    assert.strictEqual(p.createdById, USER_ID);
    assert.strictEqual(p.updatedById, USER_ID);
  });

  it('ROTATION: inherits the position\'s platoonOffset and sacafranco→isRelief', async () => {
    const db = buildAssignDb();
    db.stationPosition.rows.push(makeRow({ id: 'pos-1', tenantId: TENANT, stationId: 'st-1', type: 'sacafranco', platoonOffset: 4 }));
    db.station.rows.push(makeRow({ id: 'st-1', tenantId: TENANT, rotationStyleId: 'rot-1' }));

    await createAssignment(db, TENANT, USER_ID, {
      guardId: 'user-g1',
      stationId: 'st-1',
      positionId: 'pos-1',
      startDate: '2026-07-20',
      platoonOffset: 9, // must be IGNORED — the position is the source of truth
    });

    const p = db.guardAssignment.calls.create[0];
    assert.strictEqual(p.kind, 'rotation');
    assert.strictEqual(p.positionId, 'pos-1');
    assert.strictEqual(p.platoonOffset, 4, 'phase comes from the station position, never the request');
    assert.strictEqual(p.isRelief, true, 'a sacafranco position marks the assignment as relief');
    assert.strictEqual(p.rotationStyleId, null, 'rotation lives on the STATION, not copied onto the assignment');
  });

  it('ALTERNATION: phase follows the guard\'s startDate so "empieza hoy" = trabaja hoy', async () => {
    const db = buildAssignDb();
    // Custom station, 1-1 rotation (cycle 2), TWO fijos sharing one 24h block.
    db.station.rows.push(makeRow({ id: 'st-1', tenantId: TENANT, scheduleType: 'custom', rotationStyleId: 'rot-1' }));
    db.rotationStyle.rows.push(makeRow({ id: 'rot-1', dayShifts: 1, nightShifts: 0, restDays: 1 }));
    db.stationPosition.rows.push(makeRow({ id: 'pos-A', tenantId: TENANT, stationId: 'st-1', type: 'fijo', startTime: '00:00', endTime: '23:59', platoonOffset: 0 }));
    db.stationPosition.rows.push(makeRow({ id: 'pos-B', tenantId: TENANT, stationId: 'st-1', type: 'fijo', startTime: '00:00', endTime: '23:59', platoonOffset: 1 }));

    const startDate = '2026-07-20';
    await createAssignment(db, TENANT, USER_ID, { guardId: 'user-g1', stationId: 'st-1', positionId: 'pos-A', startDate });

    // work-day-0 = startDate ⇒ offset ≡ dse(startDate) (mod cycle), NOT the
    // position's epoch-anchored offset (0). Mirror the service's formula.
    const cycle = 2;
    const dseStart = Math.floor((Date.parse(`${startDate}T00:00:00Z`) - Date.UTC(2024, 0, 1)) / 86400000);
    const expected = ((dseStart % cycle) + cycle) % cycle;
    const p = db.guardAssignment.calls.create[0];
    assert.strictEqual(p.platoonOffset, expected, 'alternation phase must be derived from the startDate, not the position offset');
  });

  it('an unresolvable guard is a LOUD validation error, and nothing is written', async () => {
    const db = buildDb(); // no tenantUser / securityGuard rows → cannot resolve
    await assert.rejects(
      () =>
        createAssignment(db, TENANT, USER_ID, {
          guardId: 'ghost-guard',
          stationId: 'st-1',
          startDate: '2026-07-20',
        }),
      AssignmentValidationError,
    );
    assert.strictEqual(db.guardAssignment.calls.create.length, 0, 'no orphaned row may be written');
  });

  it('missing guardId/stationId is rejected before any db work', async () => {
    const db = buildDb();
    await assert.rejects(
      () => createAssignment(db, TENANT, USER_ID, { guardId: '', stationId: 'st-1' } as any),
      AssignmentValidationError,
    );
    assert.strictEqual(db.guardAssignment.calls.create.length, 0);
  });

  it('a db failure on the INSERT is NOT swallowed', async () => {
    const db = buildAssignDb();
    db.guardAssignment.create = async () => {
      throw new Error('ER_DUP_ENTRY: uniq_guard_assignment');
    };
    await assert.rejects(
      () =>
        createAssignment(db, TENANT, USER_ID, {
          guardId: 'user-g1',
          stationId: 'st-1',
          startDate: '2026-07-20',
        }),
      /ER_DUP_ENTRY/,
    );
  });
});
