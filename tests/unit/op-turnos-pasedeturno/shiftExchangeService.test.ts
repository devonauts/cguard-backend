/**
 * op-turnos · Shift EXCHANGE (intercambio de turnos) — SERVICE layer.
 *
 * The repository swap logic is pinned in crud-g04. Here we exercise the REAL
 * ShiftExchangeRequestService, which wraps every write in a transaction, to
 * prove the transaction boundary is honoured:
 *   - create commits + derives guard ids from the SHIFTS (not the payload)
 *   - a failing create ROLLS BACK and propagates (no fake success)
 *   - approval performs the swap and commits
 *   - an overlap conflict on approval ROLLS BACK (no shift moves, propagates 400)
 *   - destroy commits; a foreign-tenant id 404s and rolls back
 */
import assert from 'assert';
import sinon from 'sinon';

import ShiftExchangeRequestService from '../../../src/services/shiftExchangeRequestService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import Error404 from '../../../src/errors/Error404';
import { buildDb, repoOptions, TENANT, OTHER_TENANT } from './helpers';

const T0 = new Date('2026-07-14T06:00:00Z');
const T1 = new Date('2026-07-14T18:00:00Z');

describe('op-turnos · ShiftExchangeRequestService.create', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  function seed() {
    return {
      shift: [
        { id: 'sh-from', tenantId: TENANT, guardId: 'g-from', startTime: T0, endTime: T1, deletedAt: null },
        { id: 'sh-to', tenantId: TENANT, guardId: 'g-to', startTime: T0, endTime: T1, deletedAt: null },
      ],
    };
  }

  it('commits the transaction and derives from/to guard ids from the SHIFTS, not the client payload', async () => {
    const db = buildDb(seed());
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    const rec = await svc.create({
      fromShiftId: 'sh-from',
      toShiftId: 'sh-to',
      fromGuardId: 'forged-attacker', // must be ignored — derived from sh-from
      toGuardId: 'forged-attacker-2',
      notes: 'Cambio por cita médica',
    });

    const written = db.shiftExchangeRequest.calls.create[0];
    assert.strictEqual(written.fromGuardId, 'g-from', 'fromGuardId must come from the shift, not the payload');
    assert.strictEqual(written.toGuardId, 'g-to', 'toGuardId must come from the shift, not the payload');
    assert.strictEqual(written.status, 'pending');
    assert.strictEqual(written.notes, 'Cambio por cita médica');
    assert.strictEqual(written.tenantId, TENANT);
    assert.ok(rec && rec.id);

    // The service must have opened AND committed exactly one transaction.
    assert.strictEqual(db.sequelize.__txHistory.length, 1);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.committed, true, 'transaction not committed');
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, false);
  });

  it('rejects (and rolls back) a fromShiftId of another tenant — nothing is written', async () => {
    const db = buildDb({ shift: [{ id: 'sh-from', tenantId: OTHER_TENANT, guardId: 'x', startTime: T0, endTime: T1, deletedAt: null }] });
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await assert.rejects(() => svc.create({ fromShiftId: 'sh-from' }), /origen no válido/i);
    assert.strictEqual(db.shiftExchangeRequest.calls.create.length, 0, 'nothing must be written');
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, true, 'transaction must roll back');
  });

  it('does NOT swallow a db failure into a success (rolls back + propagates)', async () => {
    const db = buildDb(seed());
    db.shiftExchangeRequest.create = async () => {
      throw new Error('insert exploded');
    };
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await assert.rejects(() => svc.create({ fromShiftId: 'sh-from', toShiftId: 'sh-to' }), /insert exploded/);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.committed, false);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, true);
  });
});

describe('op-turnos · ShiftExchangeRequestService.updateStatus', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  function seedPending(extra: any = {}) {
    return {
      shift: [
        { id: 'sh-from', tenantId: TENANT, guardId: 'g-from', startTime: T0, endTime: T1, deletedAt: null },
        { id: 'sh-to', tenantId: TENANT, guardId: 'g-to', startTime: T0, endTime: T1, deletedAt: null },
        ...(extra.extraShifts || []),
      ],
      shiftExchangeRequest: [
        {
          id: 'req-1',
          tenantId: TENANT,
          status: 'pending',
          fromShiftId: 'sh-from',
          toShiftId: 'sh-to',
          fromGuardId: 'g-from',
          toGuardId: 'g-to',
          deletedAt: null,
        },
      ],
    };
  }

  it('approval swaps the guards on BOTH shifts and commits', async () => {
    const db = buildDb(seedPending());
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await svc.updateStatus('req-1', { status: 'approved' });

    const from = db.shift.rows.find((r: any) => r.id === 'sh-from');
    const to = db.shift.rows.find((r: any) => r.id === 'sh-to');
    assert.strictEqual(from.guardId, 'g-to', 'fromShift not reassigned to the destination guard');
    assert.strictEqual(to.guardId, 'g-from', 'toShift not reassigned to the requesting guard');
    assert.strictEqual(db.shiftExchangeRequest.rows[0].status, 'approved');
    assert.strictEqual(db.sequelize.__txHistory[0].__state.committed, true);
  });

  it('an overlap conflict ABORTS the approval: no shift moves, status stays pending, tx rolls back', async () => {
    // g-to already has another shift overlapping sh-from’s window → cannot take it.
    const db = buildDb(
      seedPending({
        extraShifts: [{ id: 'sh-block', tenantId: TENANT, guardId: 'g-to', startTime: T0, endTime: T1, deletedAt: null }],
      }),
    );
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await assert.rejects(() => svc.updateStatus('req-1', { status: 'approved' }), /se solapa/i);

    const from = db.shift.rows.find((r: any) => r.id === 'sh-from');
    assert.strictEqual(from.guardId, 'g-from', 'a conflicting exchange must not move the shift');
    assert.strictEqual(db.shiftExchangeRequest.rows[0].status, 'pending', 'status must remain pending on a failed approval');
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, true);
  });

  it('rejection only stamps the request (no shift is touched) and commits', async () => {
    const db = buildDb(seedPending());
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await svc.updateStatus('req-1', { status: 'rejected' });
    const from = db.shift.rows.find((r: any) => r.id === 'sh-from');
    assert.strictEqual(from.guardId, 'g-from', 'rejection must not move any shift');
    assert.strictEqual(db.shiftExchangeRequest.rows[0].status, 'rejected');
    assert.strictEqual(db.sequelize.__txHistory[0].__state.committed, true);
  });

  it('404s (and rolls back) for a request of another tenant', async () => {
    const db = buildDb({ shiftExchangeRequest: [{ id: 'req-1', tenantId: OTHER_TENANT, status: 'pending', deletedAt: null }] });
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await assert.rejects(() => svc.updateStatus('req-1', { status: 'approved' }), (e: any) => e instanceof Error404);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, true);
  });
});

describe('op-turnos · ShiftExchangeRequestService.destroy', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  it('destroys the tenant-scoped request and commits', async () => {
    const db = buildDb({ shiftExchangeRequest: [{ id: 'req-1', tenantId: TENANT, status: 'pending', deletedAt: null }] });
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await svc.destroy('req-1');
    assert.strictEqual(db.shiftExchangeRequest.rows[0].__destroyed, true);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.committed, true);
  });

  it('404s (and rolls back) instead of deleting a foreign-tenant request', async () => {
    const db = buildDb({ shiftExchangeRequest: [{ id: 'req-1', tenantId: OTHER_TENANT, status: 'pending', deletedAt: null }] });
    const svc = new ShiftExchangeRequestService(repoOptions(db));
    await assert.rejects(() => svc.destroy('req-1'), (e: any) => e instanceof Error404);
    assert.strictEqual(db.shiftExchangeRequest.rows[0].__destroyed, false);
    assert.strictEqual(db.sequelize.__txHistory[0].__state.rolledBack, true);
  });
});
