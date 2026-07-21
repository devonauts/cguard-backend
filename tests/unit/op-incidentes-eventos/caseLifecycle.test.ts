/**
 * Alarm-case lifecycle beyond ack/resolve (those live in crud-g06): dispatch,
 * close and note — the operator state machine + its append-only audit trail.
 *
 *   - dispatch: case → 'dispatched', stamps dispatchId/dispatchAt, creates the
 *     alarmDispatch row, writes a 'dispatch' audit entry, emits alarm.case.updated
 *   - Enhanced Call Verification gate: police dispatch for a BURGLARY without
 *     ECV/override is refused (400) — no dispatch row, no state change. Panic/
 *     holdup/fire/medical are ECV-exempt (immediate).
 *   - close: case → 'closed', stamps closedAt + disposition, back-fills resolvedAt,
 *     preserves an earlier closedAt; audit 'close'; emits alarm.case.closed
 *   - note: appends a 'note' audit row WITHOUT changing case state
 *   - tenant isolation + missing-field validation on each
 *
 * Hooks are describe-scoped per the suite convention.
 */
import assert from 'assert';
import sinon from 'sinon';

import caseDispatch from '../../../src/api/alarm/caseDispatch';
import caseClose from '../../../src/api/alarm/caseClose';
import caseNote from '../../../src/api/alarm/caseNote';
import * as pushService from '../../../src/services/pushService';
import * as policeDispatch from '../../../src/services/alarm/policeDispatch';
import { buildDb, fakeReq, fakeRes, TENANT, OTHER_TENANT, USER_ID } from './helpers';

function seedCase(over: any = {}) {
  return {
    alarmCases: [
      {
        id: 'case-1',
        tenantId: TENANT,
        alarmPanelId: 'pnl-1',
        status: 'acknowledged',
        category: 'burglary',
        priority: 2,
        ecvSatisfied: false,
        dispatchAt: null,
        closedAt: null,
        resolvedAt: null,
        disposition: null,
        deletedAt: null,
        ...over,
      },
    ],
    alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', deletedAt: null }],
  };
}

describe('op-incidentes · alarm case dispatch', () => {
  beforeEach(() => {
    sinon.stub(pushService, 'pushToTenant').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  it('guard dispatch moves the case to dispatched and records everything', async () => {
    const db = buildDb(seedCase());
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'case-1' },
      body: { type: 'guard', target: 'Unidad 4', note: 'En camino' },
    });
    const res = fakeRes();
    await caseDispatch(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.alarmCase.calls.findOne[0];
    assert.strictEqual(find.where.id, 'case-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const dispatchRow = db.alarmDispatch.calls.create[0];
    assert.ok(dispatchRow, 'no alarmDispatch row created');
    assert.strictEqual(dispatchRow.type, 'guard');
    assert.strictEqual(dispatchRow.target, 'Unidad 4');
    assert.strictEqual(dispatchRow.status, 'requested');
    assert.strictEqual(dispatchRow.dispatchedById, USER_ID);

    const createdDispatchId = db.alarmDispatch.rows[0].id;
    const caseRow = db.alarmCase.rows[0];
    assert.strictEqual(caseRow.status, 'dispatched');
    assert.strictEqual(caseRow.dispatchId, createdDispatchId, 'dispatchId not stamped on the case');
    assert.ok(caseRow.dispatchAt instanceof Date, 'dispatchAt not stamped');

    const audit = db.alarmAuditLog.calls.create.find((a: any) => a.action === 'dispatch');
    assert.ok(audit, 'no dispatch audit row');
    assert.strictEqual(audit.actorId, USER_ID);
    // Operator console update.
    const inserts = db.__queries.filter((q: any) => /platform_events/i.test(q.sql));
    assert.strictEqual(inserts[0].opts.replacements[2], 'alarm.case.updated');
  });

  it('rejects a dispatch with no type (400), writing nothing', async () => {
    const db = buildDb(seedCase());
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { target: 'x' } });
    const res = fakeRes();
    await caseDispatch(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.alarmDispatch.calls.create.length, 0);
    assert.strictEqual(db.alarmCase.rows[0].status, 'acknowledged', 'case state must be untouched');
  });

  it('ECV gate: burglary police dispatch without ECV/override is refused (400)', async () => {
    const db = buildDb(seedCase({ category: 'burglary', ecvSatisfied: false }));
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'case-1' },
      body: { type: 'police' },
    });
    const res = fakeRes();
    await caseDispatch(req, res);

    assert.strictEqual(res.statusCode, 400, 'ECV must block an unverified burglary police dispatch');
    assert.strictEqual(db.alarmDispatch.calls.create.length, 0, 'no dispatch may be created');
    assert.strictEqual(db.alarmCase.rows[0].status, 'acknowledged', 'case must not move to dispatched');
  });

  it('ECV-exempt: panic police dispatch goes through immediately', async () => {
    sinon.stub(policeDispatch, 'dispatchPolice').resolves({
      agency: 'ECU-911',
      message: 'Despacho enviado',
      mode: 'asap',
      ref: 'ASAP-REF-1',
    } as any);
    const db = buildDb(seedCase({ category: 'panic', ecvSatisfied: false }));
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { type: 'police' } });
    const res = fakeRes();
    await caseDispatch(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.alarmCase.rows[0].status, 'dispatched');
    assert.strictEqual(db.alarmCase.rows[0].asapRef, 'ASAP-REF-1', 'ASAP reference not stored');
  });

  it('dispatch on a foreign-tenant case is a 404 (nothing written)', async () => {
    const db = buildDb(seedCase({ tenantId: OTHER_TENANT }));
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { type: 'guard' } });
    const res = fakeRes();
    await caseDispatch(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmDispatch.calls.create.length, 0);
    assert.strictEqual(db.alarmCase.rows[0].__updateCalls.length, 0);
  });
});

describe('op-incidentes · alarm case close', () => {
  it('closes with a disposition and back-fills resolvedAt', async () => {
    const db = buildDb(seedCase({ status: 'dispatched', resolvedAt: null }));
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'case-1' },
      body: { disposition: 'false' },
    });
    const res = fakeRes();
    await caseClose(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const caseRow = db.alarmCase.rows[0];
    assert.strictEqual(caseRow.status, 'closed');
    assert.strictEqual(caseRow.disposition, 'false');
    assert.ok(caseRow.closedAt instanceof Date, 'closedAt not stamped');
    assert.ok(caseRow.resolvedAt instanceof Date, 'a close without a prior resolve must back-fill resolvedAt');

    const audit = db.alarmAuditLog.calls.create.find((a: any) => a.action === 'close');
    assert.ok(audit, 'no close audit row');
    assert.ok(String(audit.detail).includes('false'), 'disposition lost from audit detail');
    const inserts = db.__queries.filter((q: any) => /platform_events/i.test(q.sql));
    assert.strictEqual(inserts[0].opts.replacements[2], 'alarm.case.closed');
  });

  it('preserves an earlier resolvedAt/closedAt on close', async () => {
    const earlier = new Date('2026-07-10T00:00:00Z');
    const db = buildDb(seedCase({ status: 'resolved', resolvedAt: earlier, closedAt: null }));
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { disposition: 'real' } });
    const res = fakeRes();
    await caseClose(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.alarmCase.rows[0].resolvedAt, earlier, 'first resolvedAt must be preserved');
  });

  it('close on a foreign-tenant case is a 404', async () => {
    const db = buildDb(seedCase({ tenantId: OTHER_TENANT }));
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { disposition: 'real' } });
    const res = fakeRes();
    await caseClose(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmCase.rows[0].__updateCalls.length, 0);
  });
});

describe('op-incidentes · alarm case note', () => {
  it('appends a note to the audit timeline WITHOUT changing case state', async () => {
    const db = buildDb(seedCase({ status: 'acknowledged' }));
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'case-1' },
      body: { note: 'Cliente confirma falsa alarma por mascota' },
    });
    const res = fakeRes();
    await caseNote(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const audit = db.alarmAuditLog.calls.create[0];
    assert.ok(audit, 'no note audit row');
    assert.strictEqual(audit.action, 'note');
    assert.strictEqual(audit.detail, 'Cliente confirma falsa alarma por mascota');
    assert.strictEqual(audit.actorId, USER_ID);
    assert.strictEqual(audit.tenantId, TENANT);
    // A note is not a state transition.
    assert.strictEqual(db.alarmCase.rows[0].status, 'acknowledged', 'a note must not change status');
    assert.strictEqual(db.alarmCase.rows[0].__updateCalls.length, 0);
  });

  it('rejects an empty note (400), writing no audit row', async () => {
    const db = buildDb(seedCase());
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: {} });
    const res = fakeRes();
    await caseNote(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.alarmAuditLog.calls.create.length, 0);
  });

  it('note on a foreign-tenant case is a 404', async () => {
    const db = buildDb(seedCase({ tenantId: OTHER_TENANT }));
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { note: 'hola' } });
    const res = fakeRes();
    await caseNote(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmAuditLog.calls.create.length, 0);
  });
});
