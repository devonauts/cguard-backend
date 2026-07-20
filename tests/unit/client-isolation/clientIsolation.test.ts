/**
 * Unit tests — PER-CLIENT ISOLATION regression suite.
 *
 * A client-scoped surface (a handler/repo reached with a clientAccountId) must
 * NEVER return rows that belong to another clientAccount of the same tenant. A
 * dropped `clientAccountId` filter, or a station/sede query that forgets to
 * anchor on the requested client's sede, silently leaks customer B's roster,
 * schedule, contacts or notes into customer A's screen.
 *
 * These tests seed TWO clients (A and B) into a Sequelize-shaped fake db — each
 * carrying a unique textual marker (mirrors the live "QA-MARK-nn" seed) — then
 * exercise the REAL handler/repository code scoped to A and assert that:
 *   - every returned row belongs to A, and
 *   - B's marker / station / vigilante never appears anywhere in the payload.
 *
 * Covered (real code, no MySQL, no network — mirrors crud-g01-clients style):
 *   - clientContactRepository.findAndCountAll   (contacts, clientAccountId scope)
 *   - noteRepository.findAndCountAll            (notes, notableId scope)
 *   - clientAccountCoverage  handler            ("Puestos y cobertura" per sede)
 *   - clientAccountSchedule  handler            ("Horario" grid per sede)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/client-isolation/clientIsolation.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import ClientContactRepository from '../../../src/database/repositories/clientContactRepository';
import NoteRepository from '../../../src/database/repositories/noteRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import AttachmentRepository from '../../../src/database/repositories/attachmentRepository';

import clientAccountCoverage from '../../../src/api/clientAccount/clientAccountCoverage';
import clientAccountSchedule from '../../../src/api/clientAccount/clientAccountSchedule';
import assertClientOwnsSubResource from '../../../src/services/user/assertClientOwnsSubResource';

const Op = Sequelize.Op;

// Valid-shaped UUIDs (SequelizeFilterUtils.uuid rejects non-uuid filter values).
const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = '11111111-0000-0000-0000-000000000011';

// Client A ("QA Aislamiento 01") vs client B ("QA Aislamiento 02").
const CLIENT_A = '02c355a7-e2cf-4aaa-a51e-a9d79cea5e01';
const CLIENT_B = '51f58b8e-e36a-4505-82cc-d3dde763f0c9';
const SEDE_A = 'a11a1111-0000-0000-0000-0000000000a1';
const SEDE_B = 'b22b2222-0000-0000-0000-0000000000b2';
const STATION_A = 'a11a1111-0000-0000-0000-0000000000a2';
const STATION_B = 'b22b2222-0000-0000-0000-0000000000b3';
const GUARD_A = 'a11a1111-0000-0000-0000-0000000000a3';
const GUARD_B = 'b22b2222-0000-0000-0000-0000000000b4';

const MARK_A = 'QA-MARK-01';
const MARK_B = 'QA-MARK-02';

// ──────────────────────── Sequelize-shaped fake db ──────────────────────────
function makeRow(data: any) {
  const row: any = {
    ...data,
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (typeof row[k] === 'function') continue;
        plain[k] = row[k];
      }
      return opts && opts.plain ? { ...plain } : plain;
    },
    async update(patch: any) {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
      return row;
    },
    async reload() { return row; },
    async destroy() { row.__destroyed = true; return row; },
  };
  return row;
}

/** where matcher: equality, arrays→IN, null, Op.and/ne/in, Op.gte/lte/gt/lt. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (key === Op.or) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.some((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (typeof key === 'symbol') continue;
    const field = key as string;
    const actual = row[field];

    // Array value → SQL IN.
    if (Array.isArray(cond)) {
      if (!cond.map(String).includes(String(actual))) return false;
      continue;
    }
    // Operator object ({ [Op.gte]: ... }) — but NOT a Date/null.
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && actual === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.map(String).includes(String(actual)))) return false;
          if (s === Op.gte && !(toCmp(actual) >= toCmp(v))) return false;
          if (s === Op.lte && !(toCmp(actual) <= toCmp(v))) return false;
          if (s === Op.gt && !(toCmp(actual) > toCmp(v))) return false;
          if (s === Op.lt && !(toCmp(actual) < toCmp(v))) return false;
        }
        continue;
      }
      // Plain nested object with no operators — unused here.
    }
    // Plain equality (null included).
    if (String(actual) !== String(cond) && !(actual == null && cond == null)) {
      if (actual !== cond) return false;
    }
  }
  return true;
}
function toCmp(v: any): number {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: { findAll: [] as any[], findOne: [] as any[], findAndCountAll: [] as any[] },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where)) || null;
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => !r.__destroyed && String(r.id) === String(id)) || null;
    },
    async findAndCountAll(q: any = {}) {
      model.calls.findAndCountAll.push(q);
      const rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return { rows, count: rows.length };
    },
  };
  return model;
}

function buildDb(seed: Record<string, any[]>) {
  const db: any = { Sequelize };
  const model = (n: string) => (db[n] = makeModel(n, seed[n] || []));
  [
    'clientContact', 'note', 'clientAccount', 'businessInfo', 'station',
    'stationPosition', 'shift', 'guardShift', 'guardAssignment', 'securityGuard',
    'siteTour', 'tagScan', 'rotationStyle', 'tenant', 'user',
  ].forEach(model);
  return db;
}

// ──────────────────────── req/res doubles ───────────────────────────────────
function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}
function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}
function fakeReq(db: any, extra: any = {}) {
  return {
    currentUser: adminUser(),
    currentTenant: { id: TENANT },
    language: 'es',
    database: db,
    params: {},
    query: {},
    body: {},
    ...extra,
  } as any;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.send = (b: any) => { res.body = b; return res; };
  res.sendStatus = (c: number) => { res.statusCode = c; return res; };
  res.header = () => res;
  return res;
}

// Side channels that are not the isolation under test.
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((AttachmentRepository as any).findByNotableIds?.restore) (AttachmentRepository as any).findByNotableIds.restore();
  sinon.stub(AttachmentRepository, 'findByNotableIds').resolves([] as any);
});
afterEach(() => sinon.restore());

// ═════════════════════════════════════════════════════════════════════════════
describe('per-client isolation', () => {
  // ── Contacts ───────────────────────────────────────────────────────────────
  describe('clientContactRepository.findAndCountAll (contacts scope)', () => {
    function seedContacts() {
      return buildDb({
        clientContact: [
          { id: 'c-a', tenantId: TENANT, clientAccountId: CLIENT_A, name: `Contacto ${MARK_A}`, email: 'a@x.com' },
          { id: 'c-b', tenantId: TENANT, clientAccountId: CLIENT_B, name: `Contacto ${MARK_B}`, email: 'b@x.com' },
        ],
      });
    }

    it('scoped to client A returns ONLY A rows, never B (the leak case)', async () => {
      const db = seedContacts();
      const { rows, count } = await ClientContactRepository.findAndCountAll(
        { filter: { clientAccountId: CLIENT_A } }, repoOptions(db),
      );
      assert.strictEqual(count, 1);
      assert.ok(rows.every((r: any) => r.clientAccountId === CLIENT_A), 'every row must belong to A');
      const blob = JSON.stringify(rows);
      assert.ok(!blob.includes(MARK_B), `B marker ${MARK_B} leaked into A's contacts`);
      assert.ok(blob.includes(MARK_A), 'A marker must be present');
    });

    it('symmetric: scoped to client B returns ONLY B rows', async () => {
      const db = seedContacts();
      const { rows } = await ClientContactRepository.findAndCountAll(
        { filter: { clientAccountId: CLIENT_B } }, repoOptions(db),
      );
      assert.ok(rows.every((r: any) => r.clientAccountId === CLIENT_B));
      assert.ok(!JSON.stringify(rows).includes(MARK_A));
    });

    it('tenant scope holds: another tenant\'s contact is never returned', async () => {
      const db = buildDb({
        clientContact: [
          { id: 'c-a', tenantId: TENANT, clientAccountId: CLIENT_A, name: `Contacto ${MARK_A}` },
          { id: 'c-foreign', tenantId: OTHER_TENANT, clientAccountId: CLIENT_A, name: `Contacto ${MARK_B}` },
        ],
      });
      // Same clientAccountId, DIFFERENT tenant row present — must not surface.
      const { rows } = await ClientContactRepository.findAndCountAll(
        { filter: { clientAccountId: CLIENT_A } }, repoOptions(db),
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tenantId, TENANT);
      assert.ok(!JSON.stringify(rows).includes(MARK_B));
    });
  });

  // ── Notes ────────────────────────────────────────────────────────────────
  describe('noteRepository.findAndCountAll (notes scope)', () => {
    function seedNotes() {
      return buildDb({
        note: [
          { id: 'n-a', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: `Nota ${MARK_A}`, description: MARK_A },
          { id: 'n-b', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_B, title: `Nota ${MARK_B}`, description: MARK_B },
        ],
      });
    }

    it('scoped to client A (notableId) returns ONLY A notes', async () => {
      const db = seedNotes();
      const { rows, count } = await NoteRepository.findAndCountAll(
        { filter: { notableType: 'clientAccount', notableId: CLIENT_A } }, repoOptions(db),
      );
      assert.strictEqual(count, 1);
      assert.ok(rows.every((r: any) => r.notableId === CLIENT_A));
      const blob = JSON.stringify(rows);
      assert.ok(!blob.includes(MARK_B), `B note ${MARK_B} leaked into A`);
      assert.ok(blob.includes(MARK_A));
    });

    it('another tenant\'s note for the same clientAccount is never returned', async () => {
      const db = buildDb({
        note: [
          { id: 'n-a', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: `Nota ${MARK_A}` },
          { id: 'n-foreign', tenantId: OTHER_TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: `Nota ${MARK_B}` },
        ],
      });
      const { rows } = await NoteRepository.findAndCountAll(
        { filter: { notableType: 'clientAccount', notableId: CLIENT_A } }, repoOptions(db),
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tenantId, TENANT);
    });
  });

  // ── Coverage handler ─────────────────────────────────────────────────────
  describe('clientAccountCoverage handler ("Puestos y cobertura")', () => {
    function seedCoverage() {
      const now = new Date();
      return buildDb({
        tenant: [{ id: TENANT, timezone: 'America/Guayaquil' }],
        clientAccount: [
          { id: CLIENT_A, tenantId: TENANT, slaUptimeTarget: 95 },
          { id: CLIENT_B, tenantId: TENANT, slaUptimeTarget: 95 },
        ],
        businessInfo: [
          { id: SEDE_A, tenantId: TENANT, clientAccountId: CLIENT_A, companyName: 'Sede QA Aislamiento 01', address: 'A', city: 'GYE' },
          { id: SEDE_B, tenantId: TENANT, clientAccountId: CLIENT_B, companyName: 'Sede QA Aislamiento 02', address: 'B', city: 'GYE' },
        ],
        station: [
          { id: STATION_A, tenantId: TENANT, postSiteId: SEDE_A, stationName: 'Puesto 01', numberOfGuardsInStation: 1, scheduleType: 'day', startingTimeInDay: '07:00', finishTimeInDay: '19:00' },
          { id: STATION_B, tenantId: TENANT, postSiteId: SEDE_B, stationName: 'Puesto 02', numberOfGuardsInStation: 1, scheduleType: 'day', startingTimeInDay: '07:00', finishTimeInDay: '19:00' },
        ],
        // A guard punched in NOW at each station.
        guardShift: [
          { id: 'gs-a', tenantId: TENANT, stationNameId: STATION_A, guardNameId: GUARD_A, punchInTime: now, punchOutTime: null },
          { id: 'gs-b', tenantId: TENANT, stationNameId: STATION_B, guardNameId: GUARD_B, punchInTime: now, punchOutTime: null },
        ],
        securityGuard: [
          { id: GUARD_A, tenantId: TENANT, fullName: 'QA Vigilante 01' },
          { id: GUARD_B, tenantId: TENANT, fullName: 'QA Vigilante 02' },
        ],
        guardAssignment: [
          { id: 'ga-a', tenantId: TENANT, stationId: STATION_A, status: 'active', guard: { fullName: 'QA Vigilante 01' } },
          { id: 'ga-b', tenantId: TENANT, stationId: STATION_B, status: 'active', guard: { fullName: 'QA Vigilante 02' } },
        ],
      });
    }

    it('scoped to client A exposes ONLY A\'s sede/puesto/vigilante — never B\'s', async () => {
      const db = seedCoverage();
      const req = fakeReq(db, { params: { tenantId: TENANT, id: CLIENT_A }, query: {} });
      const res = fakeRes();
      await clientAccountCoverage(req, res);

      assert.strictEqual(res.statusCode, 200, `handler errored: ${JSON.stringify(res.body)}`);
      const payload = res.body;
      // Only A's sede in the selector.
      assert.strictEqual(payload.sedes.length, 1, 'exactly one sede (A)');
      assert.strictEqual(payload.sedes[0].id, SEDE_A);
      // Only A's puesto.
      assert.deepStrictEqual(payload.puestos.map((p: any) => p.name), ['Puesto 01']);
      // On-post guard is A's, not B's.
      assert.ok(payload.puestos[0].guards.includes('QA Vigilante 01'));

      // Nothing about B anywhere in the serialized response.
      const blob = JSON.stringify(payload);
      for (const needle of ['Puesto 02', 'QA Vigilante 02', 'Aislamiento 02', SEDE_B, STATION_B, GUARD_B]) {
        assert.ok(!blob.includes(needle), `B data leaked into A coverage: "${needle}"`);
      }
    });

    it('symmetric: scoped to client B exposes ONLY B\'s data', async () => {
      const db = seedCoverage();
      const req = fakeReq(db, { params: { tenantId: TENANT, id: CLIENT_B }, query: {} });
      const res = fakeRes();
      await clientAccountCoverage(req, res);
      assert.strictEqual(res.statusCode, 200);
      const blob = JSON.stringify(res.body);
      assert.ok(blob.includes('Puesto 02'));
      for (const needle of ['Puesto 01', 'QA Vigilante 01', SEDE_A, STATION_A]) {
        assert.ok(!blob.includes(needle), `A data leaked into B coverage: "${needle}"`);
      }
    });
  });

  // ── Schedule handler ─────────────────────────────────────────────────────
  describe('clientAccountSchedule handler ("Horario")', () => {
    function seedSchedule() {
      const now = new Date();
      return buildDb({
        tenant: [{ id: TENANT, timezone: 'America/Guayaquil' }],
        businessInfo: [
          { id: SEDE_A, tenantId: TENANT, clientAccountId: CLIENT_A, companyName: 'Sede QA Aislamiento 01' },
          { id: SEDE_B, tenantId: TENANT, clientAccountId: CLIENT_B, companyName: 'Sede QA Aislamiento 02' },
        ],
        station: [
          { id: STATION_A, tenantId: TENANT, postSiteId: SEDE_A, stationName: 'Puesto 01', scheduleType: 'day', rotationStyleId: null },
          { id: STATION_B, tenantId: TENANT, postSiteId: SEDE_B, stationName: 'Puesto 02', scheduleType: 'day', rotationStyleId: null },
        ],
        stationPosition: [
          { id: 'pos-a', tenantId: TENANT, stationId: STATION_A, name: 'Fijo 01', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: 0, deletedAt: null },
          { id: 'pos-b', tenantId: TENANT, stationId: STATION_B, name: 'Fijo 02', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: 0, deletedAt: null },
        ],
        guardAssignment: [
          { id: 'ga-a', tenantId: TENANT, stationId: STATION_A, positionId: 'pos-a', status: 'active', guardId: GUARD_A, guard: { id: GUARD_A, fullName: 'QA Vigilante 01' } },
          { id: 'ga-b', tenantId: TENANT, stationId: STATION_B, positionId: 'pos-b', status: 'active', guardId: GUARD_B, guard: { id: GUARD_B, fullName: 'QA Vigilante 02' } },
        ],
        shift: [
          { id: 'sh-a', tenantId: TENANT, stationId: STATION_A, positionId: 'pos-a', guardId: GUARD_A, startTime: now, endTime: new Date(now.getTime() + 3600000), deletedAt: null, guard: { id: GUARD_A, fullName: 'QA Vigilante 01' } },
          { id: 'sh-b', tenantId: TENANT, stationId: STATION_B, positionId: 'pos-b', guardId: GUARD_B, startTime: now, endTime: new Date(now.getTime() + 3600000), deletedAt: null, guard: { id: GUARD_B, fullName: 'QA Vigilante 02' } },
        ],
      });
    }

    it('scoped to client A shows ONLY A\'s stations/positions/vigilante — never B\'s', async () => {
      const db = seedSchedule();
      const req = fakeReq(db, { params: { tenantId: TENANT, id: CLIENT_A }, query: {} });
      const res = fakeRes();
      await clientAccountSchedule(req, res);

      assert.strictEqual(res.statusCode, 200, `handler errored: ${JSON.stringify(res.body)}`);
      const payload = res.body;
      assert.strictEqual(payload.sedes.length, 1);
      assert.strictEqual(payload.sedes[0].id, SEDE_A);
      assert.deepStrictEqual(payload.stations.map((s: any) => s.name), ['Puesto 01']);
      assert.ok(payload.rows.every((r: any) => r.stationId === STATION_A), 'every grid row anchored on A station');
      assert.ok(payload.rows.some((r: any) => r.guardName === 'QA Vigilante 01'));

      const blob = JSON.stringify(payload);
      for (const needle of ['Puesto 02', 'QA Vigilante 02', SEDE_B, STATION_B, GUARD_B, 'pos-b']) {
        assert.ok(!blob.includes(needle), `B data leaked into A schedule: "${needle}"`);
      }
    });
  });

  // ── Cross-client IDOR guard for /client-account/:id/<thing>/:subId writes ──
  // Regression for the 3 confirmed IDORs: incident status, contact, note write
  // handlers only checked tenantId, letting client A mutate client B's rows by
  // putting B's sub-id under A's path. assertClientOwnsSubResource closes it.
  describe('assertClientOwnsSubResource (sub-resource ownership guard)', () => {
    // model FK maps to the client that owns the row (incident.clientId, etc.).
    const SUB_A = 'c33c3333-0000-0000-0000-0000000000c1';
    function fakeModel(row: any) {
      return { async findByPk() { return row ? makeRow(row) : null; } };
    }
    function req(tenantId = TENANT) {
      return { currentTenant: { id: tenantId }, language: 'es' } as any;
    }

    it('passes when the sub-resource belongs to the path client', async () => {
      const model = fakeModel({ id: SUB_A, tenantId: TENANT, clientId: CLIENT_A });
      const row = await assertClientOwnsSubResource(req(), {
        model, subId: SUB_A, clientAccountId: CLIENT_A, clientKey: 'clientId',
      });
      assert.strictEqual(row.id, SUB_A);
    });

    it('THROWS when the sub-resource belongs to ANOTHER client (the IDOR)', async () => {
      const model = fakeModel({ id: SUB_A, tenantId: TENANT, clientId: CLIENT_B });
      await assert.rejects(
        () => assertClientOwnsSubResource(req(), {
          model, subId: SUB_A, clientAccountId: CLIENT_A, clientKey: 'clientId',
        }),
        /403|forbidden|prohibido/i,
      );
    });

    it('THROWS 404 when the sub-resource is in another tenant', async () => {
      const model = fakeModel({ id: SUB_A, tenantId: OTHER_TENANT, clientId: CLIENT_A });
      await assert.rejects(
        () => assertClientOwnsSubResource(req(), {
          model, subId: SUB_A, clientAccountId: CLIENT_A, clientKey: 'clientId',
        }),
      );
    });

    it('THROWS when the sub-resource id does not exist', async () => {
      const model = fakeModel(null);
      await assert.rejects(
        () => assertClientOwnsSubResource(req(), {
          model, subId: SUB_A, clientAccountId: CLIENT_A, clientKey: 'clientId',
        }),
      );
    });

    it('works with notableId (notes use a polymorphic FK)', async () => {
      const model = fakeModel({ id: SUB_A, tenantId: TENANT, notableId: CLIENT_B });
      await assert.rejects(
        () => assertClientOwnsSubResource(req(), {
          model, subId: SUB_A, clientAccountId: CLIENT_A, clientKey: 'notableId',
        }),
        /403|forbidden|prohibido/i,
      );
    });
  });
});
