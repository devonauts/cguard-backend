/**
 * Unit tests — memo isolation / recipient-scoped reads (the memoScope IDOR fix)
 * and the worker-app guard memo endpoints.
 *   - memosList handler + memoRecipientScope: a guard may list ONLY memos
 *     addressed to them; a client-supplied filter[guardName] targeting another
 *     guard is IGNORED. The CRM (management) sees everything.
 *   - guardMeMemos: the worker "Memos" list, scoped to the caller's own memos,
 *     tenant-scoped, mapped shape.
 *   - guardMeMemoAccept: acknowledgment state transition (false→true),
 *     idempotency, foreign-memo/foreign-tenant/non-guard rejection.
 *
 * REAL handlers against a Sequelize-shaped fake db (no MySQL, no network).
 */
import assert from 'assert';
import sinon from 'sinon';

import memosList from '../../../src/api/memos/memosList';
import guardMeMemos from '../../../src/api/guard/guardMeMemos';
import guardMeMemoAccept from '../../../src/api/guard/guardMeMemoAccept';
import * as notificationDispatcher from '../../../src/lib/notificationDispatcher';
import * as pushService from '../../../src/services/pushService';
import {
  buildDb, fakeReq, fakeRes, adminUser, guardUser,
  TENANT, OTHER_TENANT, SG_A, SG_B, GUARD_A_USER, GUARD_B_USER,
  MEMO_A1, MEMO_A2, MEMO_B1,
} from './helpers';

// Two guards in tenant A, one memo each for A + a second for A, one for B.
function seedMemos() {
  return {
    securityGuards: [
      { id: SG_A, tenantId: TENANT, guardId: GUARD_A_USER, fullName: 'Guardia A', deletedAt: null },
      { id: SG_B, tenantId: TENANT, guardId: GUARD_B_USER, fullName: 'Guardia B', deletedAt: null },
    ],
    memos: [
      { id: MEMO_A1, tenantId: TENANT, guardNameId: SG_A, subject: 'A-uno', content: 'c1', wasAccepted: false, dateTime: '2026-07-18T10:00:00Z', createdAt: '2026-07-18T10:00:00Z', deletedAt: null },
      { id: MEMO_A2, tenantId: TENANT, guardNameId: SG_A, subject: 'A-dos', content: 'c2', wasAccepted: true, dateTime: '2026-07-19T10:00:00Z', createdAt: '2026-07-19T10:00:00Z', deletedAt: null },
      { id: MEMO_B1, tenantId: TENANT, guardNameId: SG_B, subject: 'B-uno', content: 'c3', wasAccepted: false, dateTime: '2026-07-19T11:00:00Z', createdAt: '2026-07-19T11:00:00Z', deletedAt: null },
    ],
  };
}

describe('op-comunicacion-notif · memosList recipient scope (IDOR fix)', () => {
  beforeEach(() => {
    const FileRepo = require('../../../src/database/repositories/fileRepository').default;
    // A sibling suite may have left this wrapped — restore before re-stubbing.
    if (FileRepo.fillDownloadUrl?.restore) FileRepo.fillDownloadUrl.restore();
    sinon.stub(FileRepo, 'fillDownloadUrl').resolves(null);
  });
  afterEach(() => sinon.restore());

  it('a guard listing memos sees ONLY their own — even when spoofing filter[guardName] of another guard', async () => {
    const db = buildDb(seedMemos());
    // Guard A tries to read Guard B's memos by passing filter[guardName]=SG_B.
    const req = fakeReq(db, guardUser(GUARD_A_USER), { query: { filter: { guardName: SG_B } } });
    const res = fakeRes();
    await (memosList as any)(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const rows = res.body.rows;
    assert.strictEqual(res.body.count, 2, 'guard A must see exactly their own 2 memos');
    assert.ok(rows.every((m: any) => m.guardNameId === SG_A), 'a foreign memo leaked to guard A');
    assert.ok(!rows.some((m: any) => m.id === MEMO_B1), 'guard B memo leaked despite spoofed filter');
  });

  it('the CRM (admin) sees ALL tenant memos, no recipient scoping', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, adminUser(), { query: {} });
    const res = fakeRes();
    await (memosList as any)(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.count, 3, 'admin should see every tenant memo');
  });

  it('memo reads never cross tenants (a foreign-tenant memo is invisible to the admin)', async () => {
    const seed = seedMemos();
    seed.memos.push({ id: '33333333-3333-4333-8333-3333333333ff', tenantId: OTHER_TENANT, guardNameId: SG_A, subject: 'Ajeno', content: 'x', wasAccepted: false, dateTime: '2026-07-19T12:00:00Z', createdAt: '2026-07-19T12:00:00Z', deletedAt: null });
    const db = buildDb(seed);
    const req = fakeReq(db, adminUser(), { query: {} });
    const res = fakeRes();
    await (memosList as any)(req, res);
    assert.strictEqual(res.body.count, 3, 'a foreign-tenant memo crossed into the tenant list');
  });
});

describe('op-comunicacion-notif · guardMeMemos (worker app list)', () => {
  it('returns only the calling guard\'s memos, in the mapped worker shape', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, guardUser(GUARD_A_USER), { params: { tenantId: TENANT } });
    const res = fakeRes();
    await guardMeMemos(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.count, 2);
    assert.ok(res.body.rows.every((m: any) => [MEMO_A1, MEMO_A2].includes(m.id)));
    const accepted = res.body.rows.find((m: any) => m.id === MEMO_A2);
    assert.strictEqual(accepted.wasAccepted, true, 'acceptance flag not projected');
    assert.ok('subject' in accepted && 'content' in accepted && 'dateTime' in accepted, 'worker memo shape incomplete');
  });

  it('a non-guard caller gets an empty list (no securityGuard row)', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, adminUser(), { params: { tenantId: TENANT } });
    const res = fakeRes();
    await guardMeMemos(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { rows: [], count: 0 });
  });

  it('does not surface a memo addressed to the guard in ANOTHER tenant', async () => {
    const seed = seedMemos();
    // Same guardNameId but a different tenant row must not leak.
    seed.memos.push({ id: '33333333-3333-4333-8333-3333333333e1', tenantId: OTHER_TENANT, guardNameId: SG_A, subject: 'Ajeno', content: 'x', wasAccepted: false, dateTime: '2026-07-20T00:00:00Z', createdAt: '2026-07-20T00:00:00Z', deletedAt: null });
    const db = buildDb(seed);
    const req = fakeReq(db, guardUser(GUARD_A_USER), { params: { tenantId: TENANT } });
    const res = fakeRes();
    await guardMeMemos(req, res);
    assert.strictEqual(res.body.count, 2, 'a foreign-tenant memo leaked into the guard list');
  });
});

describe('op-comunicacion-notif · guardMeMemoAccept (acknowledgment transition)', () => {
  beforeEach(() => {
    // The accept handler fires a best-effort push + CRM dispatch — stub the
    // side channels so we assert the state transition and the dispatch call.
    if ((pushService as any).pushToTenant?.restore) (pushService as any).pushToTenant.restore();
    sinon.stub(pushService, 'pushToTenant').resolves(undefined as any);
    if ((notificationDispatcher as any).dispatch?.restore) (notificationDispatcher as any).dispatch.restore();
    sinon.stub(notificationDispatcher, 'dispatch').resolves(undefined);
  });
  afterEach(() => sinon.restore());

  it('flips wasAccepted false→true on the guard\'s own memo and dispatches memo.accepted', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, guardUser(GUARD_A_USER), { params: { tenantId: TENANT, id: MEMO_A1 } });
    const res = fakeRes();
    await guardMeMemoAccept(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.memos.rows.find((r: any) => r.id === MEMO_A1);
    assert.strictEqual(row.wasAccepted, true, 'memo not marked accepted');
    assert.strictEqual(row.__updateCalls.length, 1);

    const dispatchStub = notificationDispatcher.dispatch as sinon.SinonStub;
    assert.ok(dispatchStub.calledOnce, 'memo.accepted not dispatched to the CRM feed');
    assert.strictEqual(dispatchStub.firstCall.args[0], 'memo.accepted');
    assert.strictEqual(dispatchStub.firstCall.args[2].sourceEntityId, MEMO_A1);
    assert.strictEqual(dispatchStub.firstCall.args[2].sourceEntityType, 'memos');
  });

  it('is idempotent: re-accepting an already-accepted memo writes nothing and does not re-dispatch', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, guardUser(GUARD_A_USER), { params: { tenantId: TENANT, id: MEMO_A2 } }); // already accepted
    const res = fakeRes();
    await guardMeMemoAccept(req, res);

    assert.strictEqual(res.statusCode, 200);
    const row = db.memos.rows.find((r: any) => r.id === MEMO_A2);
    assert.strictEqual(row.__updateCalls.length, 0, 'already-accepted memo was written again');
    assert.ok((notificationDispatcher.dispatch as sinon.SinonStub).notCalled, 'idempotent accept re-dispatched');
  });

  it('rejects accepting a memo addressed to ANOTHER guard (400, no write)', async () => {
    const db = buildDb(seedMemos());
    // Guard A tries to accept Guard B's memo.
    const req = fakeReq(db, guardUser(GUARD_A_USER), { params: { tenantId: TENANT, id: MEMO_B1 } });
    const res = fakeRes();
    await guardMeMemoAccept(req, res);

    assert.strictEqual(res.statusCode, 400);
    const row = db.memos.rows.find((r: any) => r.id === MEMO_B1);
    assert.strictEqual(row.wasAccepted, false, 'another guard\'s memo was accepted');
    assert.strictEqual(row.__updateCalls.length, 0);
  });

  it('rejects a non-guard caller (400, no write)', async () => {
    const db = buildDb(seedMemos());
    const req = fakeReq(db, adminUser(), { params: { tenantId: TENANT, id: MEMO_A1 } });
    const res = fakeRes();
    await guardMeMemoAccept(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.memos.rows.find((r: any) => r.id === MEMO_A1).__updateCalls.length, 0);
  });
});
