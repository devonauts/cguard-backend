/**
 * The panic path — customer SOS (Mi Seguridad) fires the SAME full escalation
 * that a guard/alarm panic does. Covers api/customer/customerSafety#customerSos:
 *
 *   - a HIGH incident is persisted (priority 'alta', status 'abierto',
 *     callerType 'client', tenant + client scoped, coords in `location`)
 *   - a persistent alarm CASE is opened (category 'panic', priority 1,
 *     source 'client_app', linked to the incident) so the Centro de Alarmas has
 *     a real, acknowledgeable case even with no operator tab open
 *   - the CRM full-screen panic.alert is dispatched (priority 'critical')
 *   - the on-duty guards at the station get a time-sensitive push
 *   - station resolution is client-scoped: a station id the client does NOT own
 *     is ignored (falls back to the client's own station), never leaked
 *   - a customer with no client account is rejected (400), not a silent 200
 *
 * Plus the "same camino" invariant: the client SOS case and a guard/panel PANIC
 * signal both normalize to the identical {category:'panic', priority:1} shape.
 *
 * dispatch / pushToUser / stationGuardUserIds are the cross-cutting side channels
 * (CRM bell, FCM, on-duty lookup) — stubbed so we assert the fan-out contract
 * without a network. The alarm-case + incident writes hit the real fake db.
 */
import assert from 'assert';
import sinon from 'sinon';

import { customerSos } from '../../../src/api/customer/customerSafety';
import { ingestSignal } from '../../../src/services/alarm/normalizer';
import * as notificationDispatcher from '../../../src/lib/notificationDispatcher';
import * as pushService from '../../../src/services/pushService';
import * as taskNotify from '../../../src/services/taskNotify';
import { buildDb, fakeRes, flush, TENANT, USER_ID, OTHER_TENANT } from './helpers';

const CLIENT_ID = 'ca-1';

function seedSosDb(extra: any = {}) {
  return buildDb({
    clientAccounts: [{ id: CLIENT_ID, tenantId: TENANT, name: 'Empresa Acme', deletedAt: null }],
    businessInfos: [
      { id: 'ps-1', tenantId: TENANT, clientAccountId: CLIENT_ID, companyName: 'Sitio Acme', deletedAt: null },
    ],
    stations: [
      {
        id: 'st-1',
        tenantId: TENANT,
        stationOriginId: CLIENT_ID,
        postSiteId: 'ps-1',
        stationName: 'Puesto Norte',
        latitud: -0.18,
        longitud: -78.47,
        deletedAt: null,
      },
    ],
    ...extra,
  });
}

function sosReq(db: any, body: any, currentUser: any = {}) {
  return {
    database: db,
    language: 'es',
    currentUser: { id: USER_ID, tenantId: TENANT, clientAccountId: CLIENT_ID, ...currentUser },
    currentTenant: { id: TENANT },
    params: {},
    query: {},
    headers: {},
    body,
  } as any;
}

describe('op-incidentes · customer SOS (panic button → full escalation)', () => {
  let dispatchStub: sinon.SinonStub;
  let pushStub: sinon.SinonStub;
  let guardIdsStub: sinon.SinonStub;

  beforeEach(() => {
    dispatchStub = sinon.stub(notificationDispatcher, 'dispatch').resolves();
    pushStub = sinon.stub(pushService, 'pushToUser').resolves(undefined as any);
    guardIdsStub = sinon.stub(taskNotify, 'stationGuardUserIds').resolves(['guard-user-1']);
  });
  afterEach(() => sinon.restore());

  it('persists a HIGH, client-scoped incident with coordinates', async () => {
    const db = seedSosDb();
    const req = sosReq(db, { data: { message: 'Intruso en la bodega', latitude: -0.18, longitude: -78.47 } });
    const res = fakeRes();
    await customerSos(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    const inc = db.incident.calls.create[0];
    assert.ok(inc, 'no incident created');
    assert.strictEqual(inc.priority, 'alta', 'SOS must be highest priority');
    assert.strictEqual(inc.status, 'abierto');
    assert.strictEqual(inc.callerType, 'client');
    assert.strictEqual(inc.clientId, CLIENT_ID, 'incident must be scoped to the client');
    assert.strictEqual(inc.stationId, 'st-1');
    assert.strictEqual(inc.postSiteId, 'ps-1');
    assert.strictEqual(inc.tenantId, TENANT);
    assert.strictEqual(inc.location, '-0.18,-78.47', 'coordinates must be stored');
    assert.ok(String(inc.description).includes('Intruso en la bodega'), 'operator message lost');
    assert.ok(String(inc.description).includes('Empresa Acme'), 'client name must label the alert');
  });

  it('opens a persistent PANIC alarm case linked to the incident', async () => {
    const db = seedSosDb();
    const req = sosReq(db, { data: { message: 'Ayuda' } });
    const res = fakeRes();
    await customerSos(req, res);

    const c = db.alarmCase.calls.create[0];
    assert.ok(c, 'no alarm case created for the SOS');
    assert.strictEqual(c.status, 'queued');
    assert.strictEqual(c.category, 'panic');
    assert.strictEqual(c.priority, 1, 'panic must be priority 1');
    assert.strictEqual(c.source, 'client_app');
    assert.strictEqual(c.customerId, CLIENT_ID);
    assert.strictEqual(c.incidentId, res.body.incidentId, 'case must link to the SOS incident');
    assert.strictEqual(c.tenantId, TENANT);
    // The operator console is notified with the case id (RECONOCER acks THIS case).
    const inserts = db.__queries.filter((q: any) => /platform_events/i.test(q.sql));
    assert.strictEqual(inserts.length, 1, 'operator console must be notified');
    assert.strictEqual(inserts[0].opts.replacements[2], 'alarm.case.new');
  });

  it('dispatches the CRM full-screen panic.alert as critical', async () => {
    const db = seedSosDb();
    const req = sosReq(db, { data: { message: 'SOS' } });
    const res = fakeRes();
    await customerSos(req, res);

    const call = dispatchStub.getCalls().find((c) => c.args[0] === 'panic.alert');
    assert.ok(call, 'panic.alert was not dispatched');
    const payload = call!.args[1];
    assert.strictEqual(payload.source, 'client');
    assert.strictEqual(payload.priority, 'critical');
    assert.strictEqual(payload.incidentId, res.body.incidentId);
    assert.ok(payload.caseId, 'panic.alert must carry the alarm case id');
    const opts = call!.args[2];
    assert.strictEqual(opts.tenantId, TENANT, 'dispatch must be tenant-scoped');
  });

  it('pushes a time-sensitive SOS to the on-duty guards at the station', async () => {
    const db = seedSosDb();
    const req = sosReq(db, { data: { message: 'auxilio' } });
    const res = fakeRes();
    await customerSos(req, res);
    await flush();

    assert.ok(guardIdsStub.calledWith(sinon.match.any, TENANT, 'st-1'), 'on-duty lookup not scoped to the station');
    assert.strictEqual(pushStub.callCount, 1, 'exactly one guard should be pushed');
    const [, , uid, payload] = pushStub.firstCall.args;
    assert.strictEqual(uid, 'guard-user-1');
    assert.strictEqual(payload.timeSensitive, true);
    assert.strictEqual(payload.data.type, 'sos');
    assert.strictEqual(payload.data.incidentId, res.body.incidentId);
  });

  it('ISOLATION: a stationId the client does not own is ignored (uses own station)', async () => {
    const db = seedSosDb({
      // A station owned by ANOTHER client — the SOS must never target it.
      stations: [
        {
          id: 'st-1',
          tenantId: TENANT,
          stationOriginId: CLIENT_ID,
          postSiteId: 'ps-1',
          stationName: 'Puesto Norte',
          deletedAt: null,
        },
        {
          id: 'st-foreign',
          tenantId: TENANT,
          stationOriginId: 'ca-other',
          postSiteId: 'ps-other',
          stationName: 'Ajeno',
          deletedAt: null,
        },
      ],
    });
    const req = sosReq(db, { data: { stationId: 'st-foreign', message: 'x' } });
    const res = fakeRes();
    await customerSos(req, res);

    const inc = db.incident.calls.create[0];
    assert.strictEqual(inc.stationId, 'st-1', 'must fall back to the client-owned station, not the foreign one');
    assert.notStrictEqual(inc.stationId, 'st-foreign');
  });

  it('rejects a caller with no client account (400, not a silent success)', async () => {
    const db = seedSosDb();
    const req = sosReq(db, { data: {} }, { clientAccountId: null });
    const res = fakeRes();
    await customerSos(req, res);
    assert.strictEqual(res.statusCode, 400, 'must be a 400, not a fake 200');
    assert.strictEqual(db.incident.calls.create.length, 0, 'no incident may be written');
  });

  it('never fails the SOS when the guard push blows up (best-effort side channel)', async () => {
    const db = seedSosDb();
    guardIdsStub.rejects(new Error('push infra down'));
    const req = sosReq(db, { data: { message: 'x' } });
    const res = fakeRes();
    await customerSos(req, res);
    await flush();
    assert.strictEqual(res.statusCode, 200, 'a push failure must not fail the panic request');
    assert.strictEqual(db.incident.calls.create.length, 1, 'the incident must still be recorded');
  });

  it('SAME CAMINO: client SOS and a guard/panel PANIC signal normalize to panic/priority-1', async () => {
    // Client side: the SOS alarm case.
    const db1 = seedSosDb();
    await customerSos(sosReq(db1, { data: { message: 'x' } }), fakeRes());
    const sosCase = db1.alarmCase.calls.create[0];

    // Alarm/guard side: a SIA panic code and an Ademco panic code.
    const db2 = buildDb({
      alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', accountNumber: 'A1', deletedAt: null }],
    });
    const sia = await ingestSignal(db2, TENANT, { alarmPanelId: 'pnl-1', format: 'sia', eventCode: 'PA' });

    const db3 = buildDb({
      alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', accountNumber: 'A1', deletedAt: null }],
    });
    const cid = await ingestSignal(db3, TENANT, { alarmPanelId: 'pnl-1', format: 'contactid', eventCode: '120' });

    // All three land on the identical actionable shape → the SAME escalation path.
    assert.strictEqual(sosCase.category, 'panic');
    assert.strictEqual(sosCase.priority, 1);
    assert.strictEqual(sia.case.category, 'panic');
    assert.strictEqual(sia.case.priority, 1);
    assert.strictEqual(cid.case.category, 'panic');
    assert.strictEqual(cid.case.priority, 1);
  });
});
