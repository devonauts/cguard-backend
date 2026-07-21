/**
 * Unit tests — Vigilantes y personal (op-vigilantes-personal).
 *
 * Domain: securityGuard, guardLicense, licenseType, certification, staff/user,
 * and the guard lifecycle flows a security company runs daily. The g03/g12
 * suites already pin CREATE/UPDATE *field fidelity* for these repos; this suite
 * EXTENDS coverage into the parts they left open:
 *
 *   - READ / LIST scope: tenant isolation + filters + pagination for
 *     LicenseTypeRepository, CertificationRepository, GuardLicenseRepository
 *     (a list that leaks another tenant's rows, ignores a status filter, or
 *     never paginates is a real bug).
 *   - VENCIMIENTOS (expiry ranges): certification.expirationDateRange +
 *     guardLicense expiry filtering — the "which credentials expire this month"
 *     query the compliance screens depend on.
 *   - DELETE guard-de-en-uso: SecurityGuardService.destroyAll must REFUSE to
 *     remove a vigilante who still has an open guardShift, an ongoing shift, or
 *     an uncompleted patrol (_ensureNotOccupied), and must cascade user/tenantUser
 *     cleanup only when safe.
 *   - Autocomplete scope: licenseType/certification autocompletes are tenant-scoped.
 *
 * Everything runs against an in-memory Sequelize-shaped fake db (no MySQL, no
 * network), exercising the REAL production repositories/service.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-vigilantes-personal/**' + '/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import Sequelize from 'sequelize';

import LicenseTypeRepository from '../../../src/database/repositories/licenseTypeRepository';
import CertificationRepository from '../../../src/database/repositories/certificationRepository';
import GuardLicenseRepository from '../../../src/database/repositories/guardLicenseRepository';
import SecurityGuardService from '../../../src/services/securityGuardService';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
// Real UUIDs — SequelizeFilterUtils.uuid() replaces non-UUID filter values with a
// random uuid, so filter-by-id tests MUST use valid UUIDs to be meaningful.
const GUARD_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_GUARD_UUID = '22222222-2222-4222-8222-222222222222';
const LTYPE_UUID = '33333333-3333-4333-8333-333333333333';

const ADMIN = {
  id: 'admin-1',
  email: 'admin@empresa.ec',
  fullName: 'Admin Uno',
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

// ─────────────────────────── fake rows / models ─────────────────────────────
function makeRow(data: any) {
  const row: any = {
    updateCalls: [] as any[],
    destroyCalls: [] as any[],
    destroyed: false,
    saveCalls: [] as any[],
    get(_opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (typeof row[k] === 'function') continue;
        if (['updateCalls', 'destroyCalls', 'destroyed', 'saveCalls'].includes(k)) continue;
        plain[k] = row[k];
      }
      return plain;
    },
    async update(patch: any, _opts?: any) {
      row.updateCalls.push(patch);
      Object.assign(row, patch);
      return row;
    },
    async destroy(opts?: any) {
      row.destroyCalls.push(opts || {});
      row.destroyed = true;
    },
    async restore(_opts?: any) { row.destroyed = false; },
    async save(opts?: any) { row.saveCalls.push(opts || {}); return row; },
    // file/association getters some _fill paths touch — all empty.
    getImage: async () => [],
    getIcon: async () => [],
    getFrontImage: async () => [],
    getBackImage: async () => [],
    getDocument: async () => [],
  };
  Object.assign(row, data);
  return row;
}

/** Compare two scalars for gte/lte/gt/lt (dates, date-strings, numbers). */
function cmp(a: any, b: any): number {
  const na = a instanceof Date ? a.getTime() : a;
  const nb = b instanceof Date ? b.getTime() : b;
  if (typeof na === 'number' || typeof nb === 'number') {
    return Number(na) - Number(nb);
  }
  return String(na) < String(nb) ? -1 : String(na) > String(nb) ? 1 : 0;
}

/** Sequelize where matcher: equality, null, Op.or/and/in/notIn/ne/gte/lte/gt/lt.
 *  Sequelize.where(fn, ...) instances (ilike helpers) are treated as pass-through
 *  (this suite does not assert on ilike substring filters). */
function rowMatches(row: any, where: any): boolean {
  if (!where) return true;
  // Sequelize.where() instance (from ilikeIncludes) — skip, treat as satisfied.
  if (where.constructor && where.constructor.name === 'Where') return true;
  for (const key of Reflect.ownKeys(where)) {
    const val = (where as any)[key];
    if (typeof key === 'symbol') {
      if (key === Op.or) {
        if (!(val as any[]).some((c) => rowMatches(row, c))) return false;
      } else if (key === Op.and) {
        const arr = Array.isArray(val) ? val : [val];
        if (!arr.every((c) => rowMatches(row, c))) return false;
      }
      continue;
    }
    if (val === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      // Sequelize.where nested inside an array element.
      if (val.constructor && val.constructor.name === 'Where') continue;
      const syms = Object.getOwnPropertySymbols(val);
      if (syms.length) {
        for (const s of syms) {
          const opVal = (val as any)[s];
          if (s === Op.in) { if (!opVal.map(String).includes(String(row[key]))) return false; }
          else if (s === Op.notIn) { if (opVal.map(String).includes(String(row[key]))) return false; }
          else if (s === Op.ne) { if (String(row[key]) === String(opVal)) return false; }
          else if (s === Op.not) { if (opVal === null && row[key] == null) return false; }
          else if (s === Op.gte) { if (row[key] == null || cmp(row[key], opVal) < 0) return false; }
          else if (s === Op.lte) { if (row[key] == null || cmp(row[key], opVal) > 0) return false; }
          else if (s === Op.gt) { if (row[key] == null || cmp(row[key], opVal) <= 0) return false; }
          else if (s === Op.lt) { if (row[key] == null || cmp(row[key], opVal) >= 0) return false; }
        }
        continue;
      }
    }
    if (row[key] !== val) return false;
  }
  return true;
}

function visible(r: any, q: any): boolean {
  // paranoid:false includes soft-deleted rows; default excludes them.
  if (r.destroyed && !(q && q.paranoid === false)) return false;
  return true;
}

function makeModel(name: string, seedRows: any[] = []) {
  const m: any = {
    _name: name,
    rows: seedRows.map(makeRow),
    creates: [] as any[],
    findOneWheres: [] as any[],
    findAndCountArgs: [] as any[],
    bulkDestroys: [] as any[],
    async create(payload: any, _opts?: any) {
      m.creates.push(payload);
      const row = makeRow({ id: payload.id || `${name}-${m.rows.length + 1}`, ...payload });
      m.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      m.findOneWheres.push(q.where);
      return m.rows.find((r: any) => visible(r, q) && rowMatches(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      return m.rows.filter((r: any) => visible(r, q) && rowMatches(r, q.where));
    },
    async findByPk(id: any, _o?: any) {
      return m.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async findAndCountAll(q: any = {}) {
      m.findAndCountArgs.push(q);
      let matched = m.rows.filter((r: any) => visible(r, q) && rowMatches(r, q.where));
      const count = matched.length;
      const offset = q.offset ? Number(q.offset) : 0;
      const limit = q.limit ? Number(q.limit) : undefined;
      let rows = matched;
      if (offset) rows = rows.slice(offset);
      if (limit !== undefined) rows = rows.slice(0, limit);
      return { rows, count };
    },
    async count(q: any = {}) {
      return m.rows.filter((r: any) => visible(r, q) && rowMatches(r, q.where)).length;
    },
    async destroy(q: any = {}) {
      // Bulk destroy: hard-remove matching rows (force) or soft-mark them.
      const target = m.rows.filter((r: any) => rowMatches(r, q.where));
      m.bulkDestroys.push({ where: q.where, force: !!q.force, n: target.length });
      if (q.force) {
        m.rows = m.rows.filter((r: any) => !rowMatches(r, q.where));
      } else {
        for (const r of target) r.destroyed = true;
      }
      return target.length;
    },
    getTableName: () => `${name}s`,
  };
  return m;
}

function buildDb(seed: { [model: string]: any[] } = {}) {
  const modelNames = [
    'licenseType', 'certification', 'guardLicense', 'securityGuard',
    'user', 'tenantUser', 'guardShift', 'shift', 'patrol',
    'file', 'auditLog', 'businessInfo',
  ];
  const db: any = {
    Sequelize,
    sequelize: {
      transaction: async (_opts?: any, fn?: any) => {
        const tx = { commit: async () => {}, rollback: async () => {} };
        if (typeof fn === 'function') return fn(tx);
        return tx;
      },
      getQueryInterface: () => ({ bulkInsert: async () => {} }),
    },
  };
  for (const n of modelNames) db[n] = makeModel(n, seed[n] || []);
  return db;
}

function opts(db: any, over: any = {}) {
  return {
    database: db,
    currentUser: ADMIN,
    currentTenant: { id: TENANT },
    language: 'es',
    ...over,
  } as any;
}

// ════════════════════════ licenseType — LIST / READ scope ════════════════════
describe('op-vigilantes-personal · licenseType READ/LIST scope', () => {
  function seedDb() {
    return buildDb({
      licenseType: [
        { id: 'lt-a1', tenantId: TENANT, name: 'Porte de armas', status: 'active' },
        { id: 'lt-a2', tenantId: TENANT, name: 'Manejo defensivo', status: 'inactive' },
        { id: 'lt-a3', tenantId: TENANT, name: 'Primeros auxilios', status: 'active' },
        { id: 'lt-b1', tenantId: OTHER_TENANT, name: 'Ajena', status: 'active' },
      ],
    });
  }

  it('list is scoped to the tenant (never leaks another tenant rows)', async () => {
    const db = seedDb();
    const { rows, count } = await LicenseTypeRepository.findAndCountAll({ filter: {}, limit: 0, offset: 0 }, opts(db));
    assert.strictEqual(count, 3, 'only the 3 tenant-A license types');
    assert.ok(rows.every((r: any) => r.tenantId === TENANT), 'every row belongs to tenant-A');
    assert.ok(!rows.some((r: any) => r.id === 'lt-b1'), 'foreign-tenant row must not appear');
  });

  it('status filter narrows the result set', async () => {
    const db = seedDb();
    const { rows, count } = await LicenseTypeRepository.findAndCountAll({ filter: { status: 'active' }, limit: 0, offset: 0 }, opts(db));
    assert.strictEqual(count, 2, 'two active types in tenant-A');
    assert.ok(rows.every((r: any) => r.status === 'active'));
  });

  it('pagination slices the page but count reflects the full match', async () => {
    const db = seedDb();
    const page = await LicenseTypeRepository.findAndCountAll({ filter: {}, limit: 2, offset: 0 }, opts(db));
    assert.strictEqual(page.count, 3, 'count is the total, not the page size');
    assert.strictEqual(page.rows.length, 2, 'page holds only `limit` rows');

    const page2 = await LicenseTypeRepository.findAndCountAll({ filter: {}, limit: 2, offset: 2 }, opts(db));
    assert.strictEqual(page2.rows.length, 1, 'second page has the remaining row');
  });

  it('autocomplete is tenant-scoped and returns {id,label}', async () => {
    const db = seedDb();
    const out = await LicenseTypeRepository.findAllAutocomplete(null, 10, opts(db));
    assert.strictEqual(out.length, 3, 'only tenant-A types');
    assert.ok(out.every((o: any) => 'id' in o && 'label' in o), 'shape is {id,label}');
    assert.ok(!out.some((o: any) => o.id === 'lt-b1'));
  });

  it('destroy is tenant-scoped: a foreign-tenant id is a 404, nothing removed', async () => {
    const db = seedDb();
    await assert.rejects(
      LicenseTypeRepository.destroy('lt-b1', opts(db)),
      (e: any) => e.code === 404,
    );
    assert.ok(db.licenseType.rows.some((r: any) => r.id === 'lt-b1' && !r.destroyed), 'foreign row untouched');
  });

  it('destroy removes an own-tenant type', async () => {
    const db = seedDb();
    await LicenseTypeRepository.destroy('lt-a2', opts(db));
    const row = db.licenseType.rows.find((r: any) => r.id === 'lt-a2');
    assert.strictEqual(row.destroyed, true, 'the row was destroyed');
  });

  // FINDING (documented, not a broken assert): unlike SecurityGuardService, which
  // runs _ensureNotOccupied before deleting, LicenseTypeRepository.destroy has NO
  // in-use guard. A license type still referenced by guardLicense.licenseTypeId can
  // be deleted, leaving those guard licenses pointing at a vanished type. The task
  // explicitly calls for a "DELETE (guard de en-uso)" on every entity; this one has
  // none. This test PINS the current (unguarded) behavior so a future in-use guard
  // will make it fail and force an update here.
  it('FIXED: borrar un tipo de licencia EN USO se bloquea con 400 (no deja huérfanos)', async () => {
    const db = buildDb({
      licenseType: [{ id: 'lt-inuse', tenantId: TENANT, name: 'Porte de armas', status: 'active' }],
      guardLicense: [{ id: 'gl-ref', tenantId: TENANT, guardId: GUARD_UUID, licenseTypeId: 'lt-inuse', number: 'X' }],
    });
    await assert.rejects(
      LicenseTypeRepository.destroy('lt-inuse', opts(db)),
      (e: any) => e.code === 400,
      'un tipo de licencia referenciado no se puede eliminar',
    );
    // No se destruyó y la licencia del vigilante sigue apuntando a un tipo vivo.
    assert.notStrictEqual(db.licenseType.rows.find((r: any) => r.id === 'lt-inuse').destroyed, true);
  });
});

// ═══════════════════ certification — vencimientos + LIST scope ════════════════
describe('op-vigilantes-personal · certification vencimientos + scope', () => {
  function seedDb() {
    return buildDb({
      certification: [
        { id: 'c-jan', tenantId: TENANT, title: 'Vigilancia', code: 'V1', expirationDate: '2026-01-31' },
        { id: 'c-jun', tenantId: TENANT, title: 'Armas', code: 'A1', expirationDate: '2026-06-30' },
        { id: 'c-dec', tenantId: TENANT, title: 'Rescate', code: 'R1', expirationDate: '2026-12-31' },
        { id: 'c-null', tenantId: TENANT, title: 'Sin vencimiento', code: 'N1', expirationDate: null },
        { id: 'c-foreign', tenantId: OTHER_TENANT, title: 'Ajena', code: 'X1', expirationDate: '2026-06-15' },
      ],
    });
  }

  it('expirationDateRange returns only certs expiring within the window (compliance query)', async () => {
    const db = seedDb();
    const { rows, count } = await CertificationRepository.findAndCountAll(
      { filter: { expirationDateRange: ['2026-01-01', '2026-06-30'] }, limit: 0, offset: 0 },
      opts(db),
    );
    const ids = rows.map((r: any) => r.id).sort();
    assert.deepStrictEqual(ids, ['c-jan', 'c-jun'], 'only Jan + Jun certs of tenant-A');
    assert.strictEqual(count, 2);
    assert.ok(!ids.includes('c-null'), 'a cert with no expiry must not match a date window');
    assert.ok(!ids.includes('c-foreign'), 'foreign-tenant cert never leaks even inside the window');
  });

  it('an open-ended lower bound (only end date) returns everything up to that date', async () => {
    const db = seedDb();
    const { rows } = await CertificationRepository.findAndCountAll(
      { filter: { expirationDateRange: ['', '2026-06-30'] }, limit: 0, offset: 0 },
      opts(db),
    );
    const ids = rows.map((r: any) => r.id).sort();
    assert.deepStrictEqual(ids, ['c-jan', 'c-jun'], 'everything expiring on/before Jun 30');
  });

  it('list with no filter is tenant-scoped', async () => {
    const db = seedDb();
    const { rows, count } = await CertificationRepository.findAndCountAll({ filter: {}, limit: 0, offset: 0 }, opts(db));
    assert.strictEqual(count, 4, 'four tenant-A certs');
    assert.ok(rows.every((r: any) => r.tenantId === TENANT));
  });

  it('destroy of a foreign-tenant cert is a 404, nothing removed', async () => {
    const db = seedDb();
    await assert.rejects(
      CertificationRepository.destroy('c-foreign', opts(db)),
      (e: any) => e.code === 404,
    );
    assert.ok(db.certification.rows.some((r: any) => r.id === 'c-foreign' && !r.destroyed));
  });

  it('autocomplete is tenant-scoped', async () => {
    const db = seedDb();
    const out = await CertificationRepository.findAllAutocomplete(null, 10, opts(db));
    assert.strictEqual(out.length, 4, 'only tenant-A certs');
    assert.ok(!out.some((o: any) => o.id === 'c-foreign'), 'foreign cert excluded');
  });
});

// ═════════════════ guardLicense — LIST by guard + expiry + scope ═════════════
describe('op-vigilantes-personal · guardLicense LIST scope', () => {
  function seedDb() {
    return buildDb({
      guardLicense: [
        { id: 'gl-1', tenantId: TENANT, guardId: GUARD_UUID, licenseTypeId: LTYPE_UUID, number: 'A-1', expiryDate: '2027-01-01' },
        { id: 'gl-2', tenantId: TENANT, guardId: GUARD_UUID, licenseTypeId: LTYPE_UUID, number: 'A-2', expiryDate: '2026-03-01' },
        { id: 'gl-3', tenantId: TENANT, guardId: OTHER_GUARD_UUID, licenseTypeId: LTYPE_UUID, number: 'B-1', expiryDate: '2026-05-01' },
        { id: 'gl-foreign', tenantId: OTHER_TENANT, guardId: GUARD_UUID, licenseTypeId: LTYPE_UUID, number: 'F-1' },
      ],
    });
  }

  it('filtering by guardId returns only THAT guard licenses within the tenant', async () => {
    const db = seedDb();
    const { rows, count } = await GuardLicenseRepository.findAndCountAll(
      { filter: { guardId: GUARD_UUID }, limit: 0, offset: 0 },
      opts(db),
    );
    const ids = rows.map((r: any) => r.id).sort();
    assert.deepStrictEqual(ids, ['gl-1', 'gl-2'], "only this guard's two licenses");
    assert.strictEqual(count, 2);
    assert.ok(!ids.includes('gl-foreign'), 'same guardId in another tenant must not leak');
  });

  it('an unfiltered list stays tenant-scoped', async () => {
    const db = seedDb();
    const { count, rows } = await GuardLicenseRepository.findAndCountAll({ filter: {}, limit: 0, offset: 0 }, opts(db));
    assert.strictEqual(count, 3, 'three tenant-A licenses');
    assert.ok(rows.every((r: any) => r.tenantId === TENANT));
  });

  it('destroy of a foreign-tenant license is a 404 and never re-parents across tenants', async () => {
    const db = seedDb();
    await assert.rejects(
      GuardLicenseRepository.destroy('gl-foreign', opts(db)),
      (e: any) => e.code === 404,
    );
    assert.ok(db.guardLicense.rows.some((r: any) => r.id === 'gl-foreign' && !r.destroyed));
  });

  it('destroy removes an own-tenant license row', async () => {
    const db = seedDb();
    await GuardLicenseRepository.destroy('gl-2', opts(db));
    const row = db.guardLicense.rows.find((r: any) => r.id === 'gl-2');
    assert.strictEqual(row.destroyed, true);
  });
});

// ═══════════ SecurityGuardService.destroyAll — guarda de en-uso (baja) ═══════════
describe('op-vigilantes-personal · destroyAll (baja de vigilante, guard-de-en-uso)', () => {
  const GUARD_USER = 'user-guard-1';

  function baseSeed(extra: any = {}) {
    return buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: GUARD_USER, fullName: 'Vigilante Uno' }],
      user: [{ id: GUARD_USER, email: 'vig@empresa.ec', fullName: 'Vigilante Uno' }],
      tenantUser: [{ id: 'tu-1', tenantId: TENANT, userId: GUARD_USER, status: 'active' }],
      ...extra,
    });
  }

  it('REFUSES to delete a vigilante with an OPEN guardShift (punchOutTime null) → 400, nothing removed', async () => {
    const db = baseSeed({
      guardShift: [{ id: 'gsh-1', tenantId: TENANT, guardNameId: 'sg-1', punchOutTime: null }],
    });
    const svc = new SecurityGuardService(opts(db));
    await assert.rejects(svc.destroyAll(['sg-1']), (e: any) => e.code === 400);
    assert.strictEqual(db.securityGuard.rows.find((r: any) => r.id === 'sg-1').destroyed, false, 'guard not destroyed');
    assert.ok(db.user.rows.some((r: any) => r.id === GUARD_USER), 'user not removed');
  });

  it('REFUSES to delete a vigilante with an ONGOING shift (endTime in the future) → 400', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const db = baseSeed({
      shift: [{ id: 'sh-1', tenantId: TENANT, guardId: GUARD_USER, endTime: future }],
    });
    const svc = new SecurityGuardService(opts(db));
    await assert.rejects(svc.destroyAll(['sg-1']), (e: any) => e.code === 400);
    assert.strictEqual(db.securityGuard.rows.find((r: any) => r.id === 'sg-1').destroyed, false);
  });

  it('REFUSES to delete a vigilante with an UNCOMPLETED patrol → 400', async () => {
    const db = baseSeed({
      patrol: [{ id: 'p-1', tenantId: TENANT, assignedGuardId: GUARD_USER, completed: false }],
    });
    const svc = new SecurityGuardService(opts(db));
    await assert.rejects(svc.destroyAll(['sg-1']), (e: any) => e.code === 400);
    assert.strictEqual(db.securityGuard.rows.find((r: any) => r.id === 'sg-1').destroyed, false);
  });

  it('DELETES a free vigilante: guard row destroyed + tenantUser removed + user freed (no other tenant)', async () => {
    const db = baseSeed({
      guardShift: [{ id: 'gsh-done', tenantId: TENANT, guardNameId: 'sg-1', punchOutTime: new Date() }],
      shift: [{ id: 'sh-done', tenantId: TENANT, guardId: GUARD_USER, endTime: new Date(Date.now() - 3_600_000) }],
      patrol: [{ id: 'p-done', tenantId: TENANT, assignedGuardId: GUARD_USER, completed: true }],
    });
    const svc = new SecurityGuardService(opts(db));
    await svc.destroyAll(['sg-1']);

    assert.strictEqual(db.securityGuard.rows.find((r: any) => r.id === 'sg-1').destroyed, true, 'guard destroyed');
    assert.ok(!db.tenantUser.rows.some((r: any) => r.userId === GUARD_USER), 'tenantUser removed (email freed)');
    assert.ok(!db.user.rows.some((r: any) => r.id === GUARD_USER), 'user removed since no other tenant references it');
  });

  it('KEEPS the shared user account when it still belongs to another tenant', async () => {
    const db = baseSeed({
      tenantUser: [
        { id: 'tu-1', tenantId: TENANT, userId: GUARD_USER, status: 'active' },
        { id: 'tu-2', tenantId: OTHER_TENANT, userId: GUARD_USER, status: 'active' },
      ],
    });
    const svc = new SecurityGuardService(opts(db));
    await svc.destroyAll(['sg-1']);

    assert.ok(!db.tenantUser.rows.some((r: any) => r.tenantId === TENANT && r.userId === GUARD_USER), 'tenant-A membership removed');
    assert.ok(db.tenantUser.rows.some((r: any) => r.tenantId === OTHER_TENANT && r.userId === GUARD_USER), 'other-tenant membership kept');
    assert.ok(db.user.rows.some((r: any) => r.id === GUARD_USER), 'user account NOT deleted while still used elsewhere');
  });

  it('a non-existent guard id is a 404 (no silent success)', async () => {
    const db = baseSeed();
    const svc = new SecurityGuardService(opts(db));
    await assert.rejects(svc.destroyAll(['does-not-exist']), (e: any) => e.code === 404);
  });

  it('resolves the guard by its linked userId (guardId) when the id is not the PK', async () => {
    const db = baseSeed();
    const svc = new SecurityGuardService(opts(db));
    await svc.destroyAll([GUARD_USER]); // pass the user uuid, not sg-1
    assert.strictEqual(db.securityGuard.rows.find((r: any) => r.id === 'sg-1').destroyed, true, 'resolved + destroyed via guardId');
  });
});
