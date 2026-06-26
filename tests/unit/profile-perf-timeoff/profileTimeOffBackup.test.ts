/**
 * Unit tests — guard self-service: profile update, time-off (incl. the NEW
 * idempotency/dedup), and the backup/volunteer pool service.
 *
 * Mirrors backend/src/services/communication/__tests__/routing.test.ts: an
 * in-memory FAKE `db` (no MySQL, no network), sinon to stub the one external
 * side-effect (the notification dispatcher), and the REAL handlers/services
 * exercised end-to-end via node-mocks-http req/res.
 *
 * Coverage:
 *   TIME-OFF
 *     1.  Create rejects when required fields are missing (400).
 *     2.  Create inserts a pending request with the guard snapshot.
 *     3.  Create DEDUP: a double-submit (same guard/type/dates, still pending)
 *         returns the EXISTING row instead of inserting a duplicate.
 *     4.  Dedup does NOT collapse a different type / different dates.
 *     5.  A non-pending (approved) prior request does NOT block a new submit.
 *     6.  GET returns the guard's own rows (newest first), scoped to the guard.
 *     7.  GET returns { rows: [] } when the caller has no securityGuard profile.
 *   PROFILE
 *     8.  Updates phone (on user) + address (on securityGuard) and reports the
 *         changed-field list; only changed fields are written.
 *     9.  A no-op submit (same values) writes nothing and changed = [].
 *   BACKUP POOL (BackupService)
 *     10. volunteer() creates an 'offered' event with the volunteer points.
 *     11. volunteer() is idempotent per (subject, shift) — refreshes, no dup.
 *     12. confirmCover() promotes to kind 'cover' / 'confirmed' + cover points.
 *     13. reject() zeroes points and marks 'rejected'.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/profile-perf-timeoff/profileTimeOffBackup.test.ts' --exit
 */

import assert from 'assert';
import sinon from 'sinon';
import httpMocks from 'node-mocks-http';

import timeOffCreate from '../../../src/api/guard/guardMeTimeOffCreate';
import timeOffList from '../../../src/api/guard/guardMeTimeOff';
import profileUpdate from '../../../src/api/guard/guardMeProfileUpdate';
import BackupService from '../../../src/services/backupService';
import * as notificationDispatcher from '../../../src/lib/notificationDispatcher';

// ───────────────────────────── In-memory fake DB ─────────────────────────────

const TENANT_A = 'tenant-A';
const USER_ID = 'user-1';
const SG_ID = 'sg-1';

function makeRow(data: any) {
  return {
    ...data,
    get(opts?: any) {
      if (opts && opts.plain) return { ...data };
      return data;
    },
    async update(patch: any) {
      Object.assign(data, patch);
      Object.assign(this, patch);
      return this;
    },
  };
}

const matchesWhere = (row: any, where: any): boolean => {
  for (const [k, v] of Object.entries(where || {})) {
    if (v && typeof v === 'object' && '[object Object]') {
      // handle Op.ne / Op.in via symbol keys is not needed here; plain eq only
    }
    if (row[k] !== v) return false;
  }
  return true;
};

interface FakeDb {
  timeOffRows: any[];
  securityGuards: any[];
  users: Record<string, any>;
  backupEvents: any[];
  [key: string]: any;
}

function buildDb(seed: {
  securityGuard?: Record<string, any> | null;
  user?: { id: string; phoneNumber?: string; fullName?: string };
  timeOff?: any[];
  backupEvents?: any[];
} = {}): FakeDb {
  const db: FakeDb = {
    timeOffRows: (seed.timeOff || []).map((t) => makeRow({ ...t })),
    securityGuards: seed.securityGuard ? [makeRow({ ...seed.securityGuard })] : [],
    users: {},
    backupEvents: (seed.backupEvents || []).map((b) => makeRow({ ...b })),
  };
  if (seed.user) db.users[seed.user.id] = { ...seed.user };

  let toSeq = db.timeOffRows.length;
  let beSeq = db.backupEvents.length;

  // ── Model: securityGuard ────────────────────────────────────────────────
  db.securityGuard = {
    async findOne({ where }: any) {
      return (
        db.securityGuards.find(
          (g: any) =>
            (where.guardId === undefined || g.guardId === where.guardId) &&
            (where.tenantId === undefined || g.tenantId === where.tenantId || g.tenantId === undefined) &&
            (where.deletedAt === undefined || (g.deletedAt ?? null) === where.deletedAt),
        ) || null
      );
    },
  };

  // ── Model: user ─────────────────────────────────────────────────────────
  db.user = {
    async update(patch: any, { where }: any) {
      const u = db.users[where.id];
      if (u) Object.assign(u, patch);
      return [u ? 1 : 0];
    },
  };

  // ── Model: timeOffRequest ───────────────────────────────────────────────
  db.timeOffRequest = {
    async findOne({ where }: any) {
      return db.timeOffRows.find((r: any) => matchesWhere(r, where)) || null;
    },
    async findAll({ where, order }: any) {
      let rows = db.timeOffRows.filter(
        (r: any) =>
          (where.guardId === undefined || r.guardId === where.guardId) &&
          (where.tenantId === undefined || r.tenantId === where.tenantId),
      );
      if (order && order[0] && order[0][0] === 'createdAt') {
        rows = [...rows].sort((a, b) =>
          order[0][1] === 'DESC'
            ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      }
      return rows;
    },
    async create(data: any) {
      const row = makeRow({ id: `to-${++toSeq}`, createdAt: new Date(), ...data });
      db.timeOffRows.push(row);
      return row;
    },
  };

  // ── Model: backupEvent ──────────────────────────────────────────────────
  db.backupEvent = {
    async findOne({ where }: any) {
      return db.backupEvents.find((r: any) => matchesWhere(r, where)) || null;
    },
    async create(data: any) {
      const row = makeRow({ id: `be-${++beSeq}`, ...data });
      db.backupEvents.push(row);
      return row;
    },
  };

  return db;
}

/** Build a req/res pair pointed at the fake db + a logged-in guard user. */
function reqRes(db: FakeDb, opts: { method: string; body?: any; query?: any; currentUser?: any }) {
  const req: any = httpMocks.createRequest({
    method: opts.method as any,
    params: { tenantId: TENANT_A },
    body: opts.body || {},
    query: opts.query || {},
  });
  req.database = db;
  req.currentUser =
    opts.currentUser === undefined
      ? { id: USER_ID, fullName: 'Juan Pérez', email: 'juan@x.com', phoneNumber: '0990000000' }
      : opts.currentUser;
  req.currentTenant = { id: TENANT_A };
  req.language = 'es';
  const res = httpMocks.createResponse();
  return { req, res };
}

// ─────────────────────────────── Time-off ────────────────────────────────────

describe('Guard time-off — create + dedup', () => {
  let dispatchStub: sinon.SinonStub;
  beforeEach(() => {
    dispatchStub = sinon.stub(notificationDispatcher, 'dispatch').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  const SG = { id: SG_ID, guardId: USER_ID, fullName: 'Juan Pérez', tenantId: TENANT_A, deletedAt: null };

  it('1 — rejects when required fields are missing (400)', async () => {
    const db = buildDb({ securityGuard: SG });
    const { req, res } = reqRes(db, { method: 'POST', body: { data: { type: 'vacation' } } });

    await timeOffCreate(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.timeOffRows.length, 0, 'nothing should be inserted');
  });

  it('2 — inserts a pending request with the guard snapshot', async () => {
    const db = buildDb({ securityGuard: SG });
    const { req, res } = reqRes(db, {
      method: 'POST',
      body: { data: { type: 'vacation', startDate: '2026-07-01', endDate: '2026-07-05', reason: 'viaje' } },
    });

    await timeOffCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.timeOffRows.length, 1);
    const row = db.timeOffRows[0];
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.guardId, SG_ID, 'snapshots the securityGuard id');
    assert.strictEqual(row.guardName, 'Juan Pérez');
    assert.strictEqual(row.tenantId, TENANT_A);
    const body = res._getData();
    assert.strictEqual((body as any).id, row.id, 'echoes the created row');
  });

  it('3 — DEDUP: a duplicate pending submit returns the existing row (no insert)', async () => {
    const db = buildDb({
      securityGuard: SG,
      timeOff: [
        {
          id: 'to-existing',
          tenantId: TENANT_A,
          guardId: SG_ID,
          type: 'vacation',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          status: 'pending',
          deletedAt: null,
          createdAt: new Date('2026-06-01'),
        },
      ],
    });
    const { req, res } = reqRes(db, {
      method: 'POST',
      body: { data: { type: 'vacation', startDate: '2026-07-01', endDate: '2026-07-05', reason: 'dup' } },
    });

    await timeOffCreate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.timeOffRows.length, 1, 'must NOT insert a duplicate');
    assert.strictEqual((res._getData() as any).id, 'to-existing', 'returns the existing request');
  });

  it('4 — dedup does not collapse a different type or different dates', async () => {
    const db = buildDb({
      securityGuard: SG,
      timeOff: [
        {
          id: 'to-existing',
          tenantId: TENANT_A,
          guardId: SG_ID,
          type: 'vacation',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          status: 'pending',
          deletedAt: null,
          createdAt: new Date('2026-06-01'),
        },
      ],
    });
    // Different type → new row.
    const r1 = reqRes(db, {
      method: 'POST',
      body: { data: { type: 'sick', startDate: '2026-07-01', endDate: '2026-07-05' } },
    });
    await timeOffCreate(r1.req, r1.res);
    assert.strictEqual(db.timeOffRows.length, 2, 'different type is a distinct request');

    // Different dates → new row.
    const r2 = reqRes(db, {
      method: 'POST',
      body: { data: { type: 'vacation', startDate: '2026-08-01', endDate: '2026-08-02' } },
    });
    await timeOffCreate(r2.req, r2.res);
    assert.strictEqual(db.timeOffRows.length, 3, 'different dates is a distinct request');
  });

  it('5 — a prior APPROVED request does not block a new submit', async () => {
    const db = buildDb({
      securityGuard: SG,
      timeOff: [
        {
          id: 'to-approved',
          tenantId: TENANT_A,
          guardId: SG_ID,
          type: 'vacation',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          status: 'approved', // not pending → dedup must not match
          deletedAt: null,
          createdAt: new Date('2026-06-01'),
        },
      ],
    });
    const { req, res } = reqRes(db, {
      method: 'POST',
      body: { data: { type: 'vacation', startDate: '2026-07-01', endDate: '2026-07-05' } },
    });

    await timeOffCreate(req, res);

    assert.strictEqual(db.timeOffRows.length, 2, 'a fresh pending request is created');
    assert.notStrictEqual((res._getData() as any).id, 'to-approved');
  });

  it('6 — GET returns the guard own rows newest-first, scoped to the guard', async () => {
    const db = buildDb({
      securityGuard: SG,
      timeOff: [
        { id: 'a', tenantId: TENANT_A, guardId: SG_ID, status: 'pending', createdAt: new Date('2026-06-01') },
        { id: 'b', tenantId: TENANT_A, guardId: SG_ID, status: 'approved', createdAt: new Date('2026-06-10') },
        { id: 'other', tenantId: TENANT_A, guardId: 'sg-OTHER', status: 'pending', createdAt: new Date('2026-06-20') },
      ],
    });
    const { req, res } = reqRes(db, { method: 'GET' });

    await timeOffList(req, res);

    assert.strictEqual(res.statusCode, 200);
    const rows = (res._getData() as any).rows;
    assert.strictEqual(rows.length, 2, 'only the caller own requests');
    assert.deepStrictEqual(rows.map((r: any) => r.id), ['b', 'a'], 'newest first');
    assert.ok(!rows.some((r: any) => r.id === 'other'), 'other guards are excluded');
  });

  it('7 — GET returns { rows: [] } when the caller has no securityGuard profile', async () => {
    const db = buildDb({ securityGuard: null });
    const { req, res } = reqRes(db, { method: 'GET' });

    await timeOffList(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual((res._getData() as any).rows, []);
  });
});

// ─────────────────────────────── Profile ─────────────────────────────────────

describe('Guard profile self-update', () => {
  let dispatchStub: sinon.SinonStub;
  beforeEach(() => {
    dispatchStub = sinon.stub(notificationDispatcher, 'dispatch').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  it('8 — writes only the changed fields and reports them', async () => {
    const db = buildDb({
      securityGuard: { id: SG_ID, guardId: USER_ID, address: 'Calle Vieja', tenantId: TENANT_A, deletedAt: null },
      user: { id: USER_ID, phoneNumber: '0990000000', fullName: 'Juan Pérez' },
    });
    const { req, res } = reqRes(db, {
      method: 'PATCH',
      body: { data: { phone: '0991111111', address: 'Calle Nueva 123' } },
    });

    await profileUpdate(req, res);

    assert.strictEqual(res.statusCode, 200);
    const payload = res._getData() as any;
    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(payload.changed.sort(), ['dirección', 'teléfono']);
    assert.strictEqual(db.users[USER_ID].phoneNumber, '0991111111', 'phone written to user');
    assert.strictEqual(db.securityGuards[0].address, 'Calle Nueva 123', 'address written to securityGuard');
    assert.ok(dispatchStub.calledOnce, 'HR is notified once when something changed');
    assert.strictEqual(dispatchStub.firstCall.args[0], 'profile.updated');
  });

  it('9 — a no-op submit (same values) changes nothing', async () => {
    const db = buildDb({
      securityGuard: { id: SG_ID, guardId: USER_ID, address: 'Calle Vieja', tenantId: TENANT_A, deletedAt: null },
      user: { id: USER_ID, phoneNumber: '0990000000', fullName: 'Juan Pérez' },
    });
    const { req, res } = reqRes(db, {
      method: 'PATCH',
      body: { data: { phone: '0990000000', address: 'Calle Vieja' } },
    });

    await profileUpdate(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual((res._getData() as any).changed, []);
    assert.ok(dispatchStub.notCalled, 'no notification when nothing changed');
    assert.strictEqual(db.users[USER_ID].phoneNumber, '0990000000');
    assert.strictEqual(db.securityGuards[0].address, 'Calle Vieja');
  });
});

// ─────────────────────────── Backup / volunteer pool ─────────────────────────

describe('BackupService — volunteer / confirm / reject', () => {
  it('10 — volunteer() creates an offered event with volunteer points', async () => {
    const db = buildDb({});
    const ev = await BackupService.volunteer(db, {
      tenantId: TENANT_A,
      subjectUserId: USER_ID,
      securityGuardId: SG_ID,
      subjectType: 'guard',
      shiftId: 'shift-1',
      stationId: 'station-1',
      eventDate: '2026-07-01',
      notes: 'puedo cubrir',
      createdById: USER_ID,
    });

    assert.strictEqual(db.backupEvents.length, 1);
    assert.strictEqual(ev.kind, 'volunteer');
    assert.strictEqual(ev.status, 'offered');
    assert.strictEqual(ev.shiftId, 'shift-1');
    assert.strictEqual(ev.points, 1, 'default volunteer points');
    assert.strictEqual(ev.subjectUserId, USER_ID);
  });

  it('11 — volunteer() is idempotent per (subject, shift): refreshes, no duplicate', async () => {
    const db = buildDb({
      backupEvents: [
        {
          id: 'be-old',
          tenantId: TENANT_A,
          subjectUserId: USER_ID,
          kind: 'volunteer',
          shiftId: 'shift-1',
          status: 'cancelled',
          notes: 'antes',
          deletedAt: null,
          points: 1,
        },
      ],
    });

    const ev = await BackupService.volunteer(db, {
      tenantId: TENANT_A,
      subjectUserId: USER_ID,
      subjectType: 'guard',
      shiftId: 'shift-1',
      notes: 'ahora sí',
      createdById: USER_ID,
    });

    assert.strictEqual(db.backupEvents.length, 1, 'must not insert a duplicate offer');
    assert.strictEqual(ev.id, 'be-old', 'refreshes the standing offer');
    assert.strictEqual(ev.status, 'offered', 're-activated to offered');
    assert.strictEqual(ev.notes, 'ahora sí', 'notes updated');
  });

  it('12 — confirmCover() promotes to cover/confirmed with cover points', async () => {
    const db = buildDb({
      backupEvents: [
        { id: 'be-1', tenantId: TENANT_A, kind: 'volunteer', status: 'offered', points: 1, deletedAt: null },
      ],
    });

    const ev = await BackupService.confirmCover(db, {
      tenantId: TENANT_A,
      eventId: 'be-1',
      confirmedById: 'supervisor-1',
    });

    assert.ok(ev);
    assert.strictEqual(ev!.kind, 'cover');
    assert.strictEqual(ev!.status, 'confirmed');
    assert.strictEqual(ev!.points, 4, 'snapshots cover points');
    assert.strictEqual(ev!.confirmedById, 'supervisor-1');
    assert.strictEqual(db.backupEvents[0].status, 'confirmed', 'persisted');
  });

  it('12b — confirmCover() returns null for an unknown event', async () => {
    const db = buildDb({});
    const ev = await BackupService.confirmCover(db, {
      tenantId: TENANT_A,
      eventId: 'nope',
      confirmedById: 'supervisor-1',
    });
    assert.strictEqual(ev, null);
  });

  it('13 — reject() zeroes points and marks rejected', async () => {
    const db = buildDb({
      backupEvents: [
        { id: 'be-2', tenantId: TENANT_A, kind: 'volunteer', status: 'offered', points: 1, deletedAt: null },
      ],
    });

    const ev = await BackupService.reject(db, {
      tenantId: TENANT_A,
      eventId: 'be-2',
      confirmedById: 'supervisor-1',
    });

    assert.ok(ev);
    assert.strictEqual(ev!.status, 'rejected');
    assert.strictEqual(ev!.points, 0);
    assert.strictEqual(db.backupEvents[0].status, 'rejected');
  });
});
