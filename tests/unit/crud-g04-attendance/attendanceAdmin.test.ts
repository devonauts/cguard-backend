/**
 * CRUD persistence tests — attendance (AttendanceAdminService write paths).
 *
 * The Nómina admin mutations tenants use daily: approving/rejecting an
 * attendance record, resolving an exception, filing a manual correction and
 * applying it. Each test asserts the fake db's update/create call received the
 * FULL patch (nothing silently dropped), targets the right tenant-scoped row,
 * and that guard rails (payroll lock, non-pending corrections, disallowed
 * fields) fail loudly instead of pretending to save.
 *
 * dispatch()/push are best-effort by design — stubbed.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g04-attendance/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import * as dispatcherModule from '../../../src/lib/notificationDispatcher';
import AttendanceAdminService from '../../../src/services/attendanceAdminService';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const ADMIN_ID = 'user-admin-1';

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

function buildDb(seed: {
  guardShifts?: any[];
  exceptions?: any[];
  corrections?: any[];
  settingsRow?: any;
} = {}) {
  const guardShifts = (seed.guardShifts || []).map(makeRow);
  const exceptions = (seed.exceptions || []).map(makeRow);
  const corrections = (seed.corrections || []).map(makeRow);
  const correctionCreateCalls: any[] = [];
  const exceptionBulkUpdates: any[] = [];
  const audits: any[] = [];

  const byWhere = (rows: any[]) => ({ where }: any) =>
    rows.find(
      (r: any) =>
        (where.id === undefined || r.id === where.id) &&
        (where.tenantId === undefined || r.tenantId === where.tenantId),
    ) || null;

  const db: any = {
    guardShifts,
    exceptions,
    corrections,
    correctionCreateCalls,
    exceptionBulkUpdates,
    audits,
    guardShift: {
      async findOne(q: any) {
        return byWhere(guardShifts)(q);
      },
    },
    attendanceException: {
      async findOne(q: any) {
        return byWhere(exceptions)(q);
      },
      // Model-level bulk update (used to close open exceptions on approval).
      async update(patch: any, { where }: any) {
        exceptionBulkUpdates.push({ patch: { ...patch }, where: { ...where } });
        return [exceptions.length];
      },
    },
    attendanceCorrection: {
      async create(payload: any) {
        correctionCreateCalls.push({ ...payload });
        const row = makeRow({ id: `corr-new-${correctionCreateCalls.length}`, ...payload });
        corrections.push(row);
        return row;
      },
      async findOne(q: any) {
        return byWhere(corrections)(q);
      },
    },
    securityGuard: {
      async findByPk() {
        return { guardId: 'user-guard-9', fullName: 'Juan Pérez' };
      },
    },
    settings: {
      async findByPk() {
        return seed.settingsRow ?? null; // null → nominaSettings DEFAULTS (lockAfterPayrollClose: true)
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

function svc(db: any) {
  return new AttendanceAdminService({
    language: 'es',
    currentUser: { id: ADMIN_ID, email: 'admin@test.dev' },
    currentTenant: { id: TENANT },
    database: db,
  } as any);
}

describe('crud-g04 · attendance admin service', () => {
  let dispatchStub: sinon.SinonStub;
  beforeEach(() => {
    if ((dispatcherModule as any).dispatch?.restore) (dispatcherModule as any).dispatch.restore();
    dispatchStub = sinon.stub(dispatcherModule, 'dispatch').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  function seedShift(overrides: any = {}) {
    return {
      id: 'gs-1',
      tenantId: TENANT,
      locked: false,
      approvalStatus: 'pending',
      approvalNotes: null,
      status: 'late',
      guardNameId: 'sg-1',
      punchInTime: new Date('2026-07-01T08:40:00Z'),
      punchOutTime: null,
      observations: 'antes',
      ...overrides,
    };
  }

  describe('approve / reject (setApproval)', () => {
    it('approve stamps the FULL decision onto the tenant-scoped record', async () => {
      const db = buildDb({ guardShifts: [seedShift()] });
      await svc(db).approve('gs-1', { notes: 'Verificado con el supervisor' });

      const patch = db.guardShifts[0].updateCalls[0];
      assert.strictEqual(patch.approvalStatus, 'approved');
      // Approval is orthogonal to punctuality: `status` (late/on_time/overtime)
      // must be PRESERVED, never overwritten with a flat 'approved'.
      assert.strictEqual(patch.status, undefined);
      assert.strictEqual(patch.approvedById, ADMIN_ID);
      assert.ok(patch.approvedAt instanceof Date);
      assert.strictEqual(patch.approvalNotes, 'Verificado con el supervisor');
      assert.strictEqual(patch.updatedById, ADMIN_ID);

      // The record's open exceptions get closed with the same decision.
      assert.strictEqual(db.exceptionBulkUpdates.length, 1);
      const bulk = db.exceptionBulkUpdates[0];
      assert.strictEqual(bulk.patch.status, 'approved');
      assert.strictEqual(bulk.where.tenantId, TENANT);
      assert.strictEqual(bulk.where.guardShiftId, 'gs-1');
      assert.strictEqual(bulk.where.status, 'open');
    });

    it('reject stamps rejected and PRESERVES existing notes when none are sent', async () => {
      const db = buildDb({ guardShifts: [seedShift({ approvalNotes: 'nota previa' })] });
      await svc(db).reject('gs-1', {});
      const patch = db.guardShifts[0].updateCalls[0];
      assert.strictEqual(patch.approvalStatus, 'rejected');
      // `status` preserved (the seed's 'late' stays), not clobbered to 'rejected'.
      assert.strictEqual(patch.status, undefined);
      assert.strictEqual(patch.approvalNotes, 'nota previa');
    });

    it('a LOCKED record (closed payroll period) refuses the write loudly', async () => {
      const db = buildDb({ guardShifts: [seedShift({ locked: true })] });
      await assert.rejects(() => svc(db).approve('gs-1', { notes: 'x' }), Error400);
      assert.strictEqual(db.guardShifts[0].updateCalls.length, 0, 'locked row must not be touched');
    });

    it('404s for another tenant\'s record instead of approving it', async () => {
      const db = buildDb({ guardShifts: [seedShift({ tenantId: OTHER_TENANT })] });
      await assert.rejects(() => svc(db).approve('gs-1', {}), Error404);
      assert.strictEqual(db.guardShifts[0].updateCalls.length, 0);
    });

    it('a db failure on the decision write is NOT swallowed', async () => {
      const db = buildDb({ guardShifts: [seedShift()] });
      db.guardShifts[0].update = async () => {
        throw new Error('ER_LOCK_DEADLOCK');
      };
      await assert.rejects(() => svc(db).approve('gs-1', {}), /ER_LOCK_DEADLOCK/);
    });
  });

  describe('resolveException', () => {
    it('applies status + resolutionNotes + resolver stamps to the tenant-scoped row', async () => {
      const db = buildDb({
        exceptions: [{ id: 'exc-1', tenantId: TENANT, status: 'open', resolutionNotes: null }],
      });
      await svc(db).resolveException('exc-1', { status: 'acknowledged', resolutionNotes: 'Visto y validado' });

      const patch = db.exceptions[0].updateCalls[0];
      assert.strictEqual(patch.status, 'acknowledged');
      assert.strictEqual(patch.resolutionNotes, 'Visto y validado');
      assert.strictEqual(patch.resolvedById, ADMIN_ID);
      assert.ok(patch.resolvedAt instanceof Date);
      assert.strictEqual(patch.updatedById, ADMIN_ID);
    });

    it('coerces an unknown status to "resolved" and preserves prior notes when none sent', async () => {
      const db = buildDb({
        exceptions: [{ id: 'exc-1', tenantId: TENANT, status: 'open', resolutionNotes: 'ya anotado' }],
      });
      await svc(db).resolveException('exc-1', { status: 'nonsense' });
      const patch = db.exceptions[0].updateCalls[0];
      assert.strictEqual(patch.status, 'resolved');
      assert.strictEqual(patch.resolutionNotes, 'ya anotado');
    });

    it('404s for another tenant\'s exception', async () => {
      const db = buildDb({ exceptions: [{ id: 'exc-1', tenantId: OTHER_TENANT, status: 'open' }] });
      await assert.rejects(() => svc(db).resolveException('exc-1', { status: 'resolved' }), Error404);
    });
  });

  describe('correct (manual correction request)', () => {
    it('persists the FULL correction (field, original + corrected value, reason, stamps) and flags the record', async () => {
      const db = buildDb({ guardShifts: [seedShift({ approvalStatus: 'none' })] });
      await svc(db).correct('gs-1', {
        field: 'observations',
        correctedValue: 'texto corregido',
        reason: 'El vigilante no pudo escribir la novedad',
      });

      assert.strictEqual(db.correctionCreateCalls.length, 1);
      const p = db.correctionCreateCalls[0];
      assert.strictEqual(p.field, 'observations');
      assert.strictEqual(p.originalValue, 'antes');
      assert.strictEqual(p.correctedValue, 'texto corregido');
      assert.strictEqual(p.reason, 'El vigilante no pudo escribir la novedad');
      assert.strictEqual(p.status, 'pending');
      assert.strictEqual(p.guardShiftId, 'gs-1');
      assert.strictEqual(p.requestedById, ADMIN_ID);
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, ADMIN_ID);
      assert.strictEqual(p.updatedById, ADMIN_ID);

      // The attendance record is flagged pending for the approvals queue.
      const patch = db.guardShifts[0].updateCalls[0];
      assert.strictEqual(patch.approvalStatus, 'pending');
    });

    it('rejects a field outside the whitelist — nothing is written', async () => {
      const db = buildDb({ guardShifts: [seedShift()] });
      await assert.rejects(
        () => svc(db).correct('gs-1', { field: 'punchInLatitude', correctedValue: '0', reason: 'x' }),
        Error400,
      );
      assert.strictEqual(db.correctionCreateCalls.length, 0);
    });

    it('rejects a correction without a reason', async () => {
      const db = buildDb({ guardShifts: [seedShift()] });
      await assert.rejects(
        () => svc(db).correct('gs-1', { field: 'observations', correctedValue: 'x', reason: '' }),
        Error400,
      );
      assert.strictEqual(db.correctionCreateCalls.length, 0);
    });
  });

  describe('applyCorrection', () => {
    function seedCorrection(overrides: any = {}) {
      return {
        id: 'corr-1',
        tenantId: TENANT,
        status: 'pending',
        field: 'punchInTime',
        originalValue: '2026-07-01T08:40:00.000Z',
        correctedValue: '2026-07-01T08:00:00.000Z',
        guardShiftId: 'gs-1',
        ...overrides,
      };
    }

    it('approval APPLIES the corrected value to the guardShift (dates revived as Date)', async () => {
      const db = buildDb({ guardShifts: [seedShift()], corrections: [seedCorrection()] });
      await svc(db).applyCorrection('corr-1', { decision: 'approved', notes: 'ok' });

      const shiftPatch = db.guardShifts[0].updateCalls.find((c: any) => 'punchInTime' in c);
      assert.ok(shiftPatch, 'the corrected field must land on the guardShift');
      assert.ok(shiftPatch.punchInTime instanceof Date);
      assert.strictEqual(shiftPatch.punchInTime.toISOString(), '2026-07-01T08:00:00.000Z');
      assert.strictEqual(shiftPatch.updatedById, ADMIN_ID);

      const corrPatch = db.corrections[0].updateCalls[0];
      assert.strictEqual(corrPatch.status, 'applied');
      assert.strictEqual(corrPatch.approvedById, ADMIN_ID);
      assert.ok(corrPatch.approvedAt instanceof Date);
      assert.strictEqual(corrPatch.approvalNotes, 'ok');
    });

    it('rejection stamps the correction rejected and leaves the guardShift untouched', async () => {
      const db = buildDb({ guardShifts: [seedShift()], corrections: [seedCorrection()] });
      await svc(db).applyCorrection('corr-1', { decision: 'rejected', notes: 'no procede' });

      assert.strictEqual(db.guardShifts[0].updateCalls.length, 0);
      const corrPatch = db.corrections[0].updateCalls[0];
      assert.strictEqual(corrPatch.status, 'rejected');
      assert.strictEqual(corrPatch.approvalNotes, 'no procede');
    });

    it('a non-pending correction cannot be re-applied (fails loudly)', async () => {
      const db = buildDb({
        guardShifts: [seedShift()],
        corrections: [seedCorrection({ status: 'applied' })],
      });
      await assert.rejects(
        () => svc(db).applyCorrection('corr-1', { decision: 'approved' }),
        Error400,
      );
      assert.strictEqual(db.guardShifts[0].updateCalls.length, 0);
    });

    it('404s for another tenant\'s correction', async () => {
      const db = buildDb({ corrections: [seedCorrection({ tenantId: OTHER_TENANT })] });
      await assert.rejects(() => svc(db).applyCorrection('corr-1', { decision: 'approved' }), Error404);
    });
  });
});
