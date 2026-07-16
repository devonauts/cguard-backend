/**
 * CRUD persistence tests — timeOffRequest (TimeOffRequestRepository).
 *
 * Field-fidelity net for the vacaciones/permisos flow: every field the CRM /
 * worker-app form sends must reach the INSERT, updateStatus must target the
 * right row (id + tenantId) and apply the decision, and db failures must
 * propagate. In-memory fake db, no MySQL, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g04-attendance/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import TimeOffRequestRepository from '../../../src/database/repositories/timeOffRequestRepository';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-hr-1';

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

function buildDb(seed: { timeOffRequests?: any[] } = {}) {
  const rows = (seed.timeOffRequests || []).map(makeRow);
  const createCalls: any[] = [];
  const findOneCalls: any[] = [];
  const audits: any[] = [];

  const db: any = {
    rows,
    createCalls,
    findOneCalls,
    audits,
    user: {}, // referenced in `include` only
    timeOffRequest: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeRow({ id: `to-new-${createCalls.length}`, ...payload });
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
    currentUser: { id: USER_ID, email: 'hr@test.dev' },
    currentTenant: { id: TENANT },
    database: db,
  } as any;
}

/** Every writable field the time-off form sends. */
function fullPayload() {
  return {
    requestDate: new Date('2026-07-10T12:00:00Z'),
    type: 'vacation',
    startDate: '2026-07-20',
    startTime: '08:00',
    endDate: '2026-07-25',
    endTime: '17:00',
    reason: 'Vacaciones anuales',
    comment: 'Aprobado verbalmente por el jefe',
    isPaid: true,
    guard: 'user-guard-9', // guardId is the USER id (project convention)
  };
}

describe('crud-g04 · timeOffRequest repository', () => {
  describe('create — field fidelity', () => {
    it('persists EVERY writable field with the exact value sent', async () => {
      const db = buildDb();
      await TimeOffRequestRepository.create(fullPayload(), options(db));

      assert.strictEqual(db.createCalls.length, 1);
      const p = db.createCalls[0];
      assert.deepStrictEqual(p.requestDate, new Date('2026-07-10T12:00:00Z'));
      assert.strictEqual(p.type, 'vacation');
      assert.strictEqual(p.startDate, '2026-07-20');
      assert.strictEqual(p.startTime, '08:00');
      assert.strictEqual(p.endDate, '2026-07-25');
      assert.strictEqual(p.endTime, '17:00');
      assert.strictEqual(p.reason, 'Vacaciones anuales');
      assert.strictEqual(p.comment, 'Aprobado verbalmente por el jefe');
      assert.strictEqual(p.isPaid, true);
      assert.strictEqual(p.guardId, 'user-guard-9');
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);
    });

    it('accepts guardId directly when guard is not sent', async () => {
      const db = buildDb();
      const data: any = fullPayload();
      delete data.guard;
      data.guardId = 'user-guard-direct';
      await TimeOffRequestRepository.create(data, options(db));
      assert.strictEqual(db.createCalls[0].guardId, 'user-guard-direct');
    });

    it('forces status=pending on create — a client cannot self-approve', async () => {
      const db = buildDb();
      const data: any = fullPayload();
      data.status = 'approved'; // forged
      await TimeOffRequestRepository.create(data, options(db));
      assert.strictEqual(db.createCalls[0].status, 'pending');
    });

    it('does NOT swallow a db failure into a success', async () => {
      const db = buildDb();
      db.timeOffRequest.create = async () => {
        throw new Error('ER_DATA_TOO_LONG: reason');
      };
      await assert.rejects(
        () => TimeOffRequestRepository.create(fullPayload(), options(db)),
        /ER_DATA_TOO_LONG/,
      );
      assert.strictEqual(db.audits.length, 0);
    });
  });

  describe('updateStatus — the approval decision actually lands on the right row', () => {
    function seedRow(overrides: any = {}) {
      return {
        id: 'to-1',
        tenantId: TENANT,
        status: 'pending',
        comment: 'comentario original',
        guardId: 'user-guard-9',
        startDate: '2026-07-20',
        endDate: '2026-07-25',
        ...overrides,
      };
    }

    it('targets the row by id AND tenantId and applies status + comment + updatedById', async () => {
      const db = buildDb({ timeOffRequests: [seedRow()] });
      await TimeOffRequestRepository.updateStatus(
        'to-1',
        { status: 'approved', comment: 'Disfruta tus vacaciones' },
        options(db),
      );

      const where = db.findOneCalls[0];
      assert.strictEqual(where.id, 'to-1');
      assert.strictEqual(where.tenantId, TENANT);

      const patch = db.rows[0].updateCalls[0];
      assert.strictEqual(patch.status, 'approved');
      assert.strictEqual(patch.comment, 'Disfruta tus vacaciones');
      assert.strictEqual(patch.updatedById, USER_ID);
      assert.strictEqual(db.rows[0].status, 'approved');
    });

    it('preserves the existing comment when the decision carries none', async () => {
      const db = buildDb({ timeOffRequests: [seedRow()] });
      await TimeOffRequestRepository.updateStatus('to-1', { status: 'rejected' }, options(db));
      const patch = db.rows[0].updateCalls[0];
      assert.strictEqual(patch.status, 'rejected');
      assert.strictEqual(patch.comment, 'comentario original');
    });

    it('404s instead of silently no-opping for another tenant\'s request', async () => {
      const db = buildDb({ timeOffRequests: [seedRow({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => TimeOffRequestRepository.updateStatus('to-1', { status: 'approved' }, options(db)),
        Error404,
      );
      assert.strictEqual(db.rows[0].updateCalls.length, 0);
    });

    it('does NOT swallow a db failure on the decision write', async () => {
      const db = buildDb({ timeOffRequests: [seedRow()] });
      db.rows[0].update = async () => {
        throw new Error('Deadlock found when trying to get lock');
      };
      await assert.rejects(
        () => TimeOffRequestRepository.updateStatus('to-1', { status: 'approved' }, options(db)),
        /Deadlock/,
      );
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row', async () => {
      const db = buildDb({ timeOffRequests: [{ id: 'to-1', tenantId: TENANT }] });
      await TimeOffRequestRepository.destroy('to-1', options(db));
      assert.strictEqual(db.rows[0].destroyed, true);
    });

    it('404s for another tenant\'s row', async () => {
      const db = buildDb({ timeOffRequests: [{ id: 'to-1', tenantId: OTHER_TENANT }] });
      await assert.rejects(() => TimeOffRequestRepository.destroy('to-1', options(db)), Error404);
      assert.strictEqual(db.rows[0].destroyed, false);
    });
  });
});
