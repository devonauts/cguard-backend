/**
 * CRUD persistence tests — shiftExchangeRequest (ShiftExchangeRequestRepository).
 *
 * Covers: create field fidelity (incl. guard ids DERIVED from the tenant's
 * shifts, never trusted from the client), approval actually swapping the
 * shifts' guardId, tenant-scoped where clauses, overlap conflicts aborting the
 * whole approval, and db failures propagating. In-memory fake db.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g04-attendance/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import ShiftExchangeRequestRepository from '../../../src/database/repositories/shiftExchangeRequestRepository';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-ops-1';

function makeRow(data: any) {
  const row: any = {
    ...data,
    updateCalls: [] as any[],
    destroyed: false,
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
  };
  return row;
}

function buildDb(seed: { shifts?: any[]; exchanges?: any[]; overlapConflict?: boolean } = {}) {
  const shifts = (seed.shifts || []).map(makeRow);
  const rows = (seed.exchanges || []).map(makeRow);
  const createCalls: any[] = [];
  const findOneCalls: any[] = [];
  const overlapQueries: any[] = [];
  const audits: any[] = [];

  const db: any = {
    shifts,
    rows,
    createCalls,
    findOneCalls,
    overlapQueries,
    audits,
    user: {},
    shift: {
      async findOne({ where }: any) {
        // findGuardShiftOverlap queries by guardId + time range; the id/tenant
        // lookups query by a plain string id.
        if (where.guardId !== undefined) {
          overlapQueries.push({ ...where });
          return seed.overlapConflict ? makeRow({ id: 'sh-conflict' }) : null;
        }
        return (
          shifts.find(
            (s: any) =>
              s.id === where.id &&
              (where.tenantId === undefined || s.tenantId === where.tenantId),
          ) || null
        );
      },
    },
    shiftExchangeRequest: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeRow({ id: `ex-new-${createCalls.length}`, ...payload });
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
    language: 'es',
    currentUser: { id: USER_ID, email: 'ops@test.dev' },
    currentTenant: { id: TENANT },
    database: db,
  } as any;
}

const FROM_SHIFT = {
  id: 'sh-A',
  tenantId: TENANT,
  guardId: 'guard-1',
  startTime: '2026-07-20T08:00:00Z',
  endTime: '2026-07-20T16:00:00Z',
};
const TO_SHIFT = {
  id: 'sh-B',
  tenantId: TENANT,
  guardId: 'guard-2',
  startTime: '2026-07-21T08:00:00Z',
  endTime: '2026-07-21T16:00:00Z',
};

describe('crud-g04 · shiftExchangeRequest repository', () => {
  describe('create — field fidelity + derived guard ids', () => {
    it('persists every field; guard ids come from the SHIFTS, not the client payload', async () => {
      const db = buildDb({ shifts: [FROM_SHIFT, TO_SHIFT] });
      const data = {
        requestDate: new Date('2026-07-12T10:00:00Z'),
        fromShiftId: 'sh-A',
        toShiftId: 'sh-B',
        fromGuardId: 'FORGED-1', // must be ignored — shifts carry the truth
        toGuardId: 'FORGED-2',
        notes: 'Cambio por cita médica',
      };
      await ShiftExchangeRequestRepository.create(data, options(db));

      assert.strictEqual(db.createCalls.length, 1);
      const p = db.createCalls[0];
      assert.deepStrictEqual(p.requestDate, new Date('2026-07-12T10:00:00Z'));
      assert.strictEqual(p.fromShiftId, 'sh-A');
      assert.strictEqual(p.toShiftId, 'sh-B');
      assert.strictEqual(p.fromGuardId, 'guard-1');
      assert.strictEqual(p.toGuardId, 'guard-2');
      assert.strictEqual(p.notes, 'Cambio por cita médica');
      assert.strictEqual(p.status, 'pending');
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);
    });

    it('rejects (400) a fromShiftId that does not belong to this tenant — nothing is written', async () => {
      const db = buildDb({ shifts: [{ ...FROM_SHIFT, tenantId: OTHER_TENANT }] });
      await assert.rejects(
        () =>
          ShiftExchangeRequestRepository.create(
            { fromShiftId: 'sh-A', notes: 'x' },
            options(db),
          ),
        (e: any) => e.code === 400,
      );
      assert.strictEqual(db.createCalls.length, 0);
    });

    it('does NOT swallow a db failure into a success', async () => {
      const db = buildDb({ shifts: [FROM_SHIFT, TO_SHIFT] });
      db.shiftExchangeRequest.create = async () => {
        throw new Error('ER_LOCK_DEADLOCK');
      };
      await assert.rejects(
        () =>
          ShiftExchangeRequestRepository.create(
            { fromShiftId: 'sh-A', toShiftId: 'sh-B' },
            options(db),
          ),
        /ER_LOCK_DEADLOCK/,
      );
    });
  });

  describe('updateStatus — the decision AND the swap must both persist', () => {
    function seedExchange(overrides: any = {}) {
      return {
        id: 'ex-1',
        tenantId: TENANT,
        status: 'pending',
        fromShiftId: 'sh-A',
        toShiftId: 'sh-B',
        fromGuardId: 'guard-1',
        toGuardId: 'guard-2',
        notes: 'n',
        ...overrides,
      };
    }

    it('approval swaps the guards on BOTH shifts and stamps the request approved', async () => {
      const db = buildDb({ shifts: [FROM_SHIFT, TO_SHIFT], exchanges: [seedExchange()] });
      await ShiftExchangeRequestRepository.updateStatus('ex-1', { status: 'approved' }, options(db));

      const fromShift = db.shifts.find((s: any) => s.id === 'sh-A');
      const toShift = db.shifts.find((s: any) => s.id === 'sh-B');
      assert.deepStrictEqual(fromShift.updateCalls[0], { guardId: 'guard-2', updatedById: USER_ID });
      assert.deepStrictEqual(toShift.updateCalls[0], { guardId: 'guard-1', updatedById: USER_ID });

      const reqPatch = db.rows[0].updateCalls[0];
      assert.strictEqual(reqPatch.status, 'approved');
      assert.strictEqual(reqPatch.updatedById, USER_ID);
      // Both directions were overlap-checked before moving anything.
      assert.strictEqual(db.overlapQueries.length, 2);
    });

    it('an overlap conflict ABORTS the approval — no shift moves, status stays pending', async () => {
      const db = buildDb({
        shifts: [FROM_SHIFT, TO_SHIFT],
        exchanges: [seedExchange()],
        overlapConflict: true,
      });
      await assert.rejects(
        () => ShiftExchangeRequestRepository.updateStatus('ex-1', { status: 'approved' }, options(db)),
        /solapa/,
      );
      const fromShift = db.shifts.find((s: any) => s.id === 'sh-A');
      const toShift = db.shifts.find((s: any) => s.id === 'sh-B');
      assert.strictEqual(fromShift.updateCalls.length, 0);
      assert.strictEqual(toShift.updateCalls.length, 0);
      assert.strictEqual(db.rows[0].status, 'pending');
    });

    it('rejection only stamps the request (no shift is touched) on the tenant-scoped row', async () => {
      const db = buildDb({ shifts: [FROM_SHIFT, TO_SHIFT], exchanges: [seedExchange()] });
      await ShiftExchangeRequestRepository.updateStatus('ex-1', { status: 'rejected' }, options(db));

      assert.strictEqual(db.findOneCalls[0].id, 'ex-1');
      assert.strictEqual(db.findOneCalls[0].tenantId, TENANT);
      const reqPatch = db.rows[0].updateCalls[0];
      assert.strictEqual(reqPatch.status, 'rejected');
      assert.strictEqual(db.shifts[0].updateCalls.length, 0);
      assert.strictEqual(db.shifts[1].updateCalls.length, 0);
    });

    it('approving when the origin shift no longer exists fails loudly (400), not silently', async () => {
      const db = buildDb({ shifts: [], exchanges: [seedExchange()] });
      await assert.rejects(
        () => ShiftExchangeRequestRepository.updateStatus('ex-1', { status: 'approved' }, options(db)),
        (e: any) => e.code === 400,
      );
      assert.strictEqual(db.rows[0].status, 'pending');
    });

    it('404s for another tenant\'s request', async () => {
      const db = buildDb({ exchanges: [seedExchange({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => ShiftExchangeRequestRepository.updateStatus('ex-1', { status: 'approved' }, options(db)),
        Error404,
      );
      assert.strictEqual(db.rows[0].updateCalls.length, 0);
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row and 404s for a foreign one', async () => {
      const db = buildDb({
        exchanges: [
          { id: 'ex-mine', tenantId: TENANT },
          { id: 'ex-theirs', tenantId: OTHER_TENANT },
        ],
      });
      await ShiftExchangeRequestRepository.destroy('ex-mine', options(db));
      assert.strictEqual(db.rows[0].destroyed, true);
      await assert.rejects(() => ShiftExchangeRequestRepository.destroy('ex-theirs', options(db)), Error404);
      assert.strictEqual(db.rows[1].destroyed, false);
    });
  });
});
