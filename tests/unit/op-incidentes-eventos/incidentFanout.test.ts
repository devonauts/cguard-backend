/**
 * Incident event fan-out — a reported incident is not just a row, it triggers a
 * three-way notification fan-out (IncidentService.create):
 *
 *   1) dispatch('incident.created')            → CRM bell / in-app + email
 *   2) sendIncidentAlert(...) per supervisor   → push-first / WhatsApp / SMS,
 *      escalated to CRITICAL when the incident priority is high (alta/high/critical)
 *   3) notifyClient(...) 'incident.created'     → the owning client's app + feed
 *
 * All three legs are best-effort (never block/fail the create). This suite stubs
 * the side channels and asserts the fan-out CONTRACT: which channel fires, with
 * what payload, and that severity correctly drives the critical flag.
 *
 * Hooks are describe-scoped per the suite convention.
 */
import assert from 'assert';
import sinon from 'sinon';

import IncidentService from '../../../src/services/incidentService';
import IncidentRepository from '../../../src/database/repositories/incidentRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import * as notificationDispatcher from '../../../src/lib/notificationDispatcher';
import * as communicationService from '../../../src/services/communication/communicationService';
import * as operationalRecipients from '../../../src/services/communication/operationalRecipients';
import * as clientNotifyService from '../../../src/services/clientNotifyService';
import { buildDb, repoOptions, flush, safeStub, TENANT } from './helpers';

const seedRelations = {
  stations: [{ id: 'st-1', tenantId: TENANT, stationName: 'Puesto 1', deletedAt: null }],
  incidentTypes: [{ id: 'it-1', tenantId: TENANT, name: 'Robo', deletedAt: null }],
  businessInfos: [{ id: 'ps-1', tenantId: TENANT, companyName: 'Sitio 1', deletedAt: null }],
  clientAccounts: [{ id: 'ca-1', tenantId: TENANT, name: 'Cliente 1', deletedAt: null }],
  securityGuards: [{ id: 'sg-1', tenantId: TENANT, fullName: 'Vigilante 1', deletedAt: null }],
};

describe('op-incidentes · incident create event fan-out', () => {
  let dispatchStub: sinon.SinonStub;
  let alertStub: sinon.SinonStub;
  let supIdsStub: sinon.SinonStub;
  let notifyClientStub: sinon.SinonStub;

  beforeEach(() => {
    safeStub(sinon, AuditLogRepository, 'log').resolves();
    safeStub(sinon, FileRepository, 'replaceRelationFiles').resolves();
    safeStub(sinon, FileRepository, 'fillDownloadUrl').resolves(null as any);
    dispatchStub = sinon.stub(notificationDispatcher, 'dispatch').resolves();
    alertStub = sinon.stub(communicationService, 'sendIncidentAlert').resolves([] as any);
    supIdsStub = sinon.stub(operationalRecipients, 'resolveSupervisorUserIds').resolves(['sup-1', 'sup-2']);
    notifyClientStub = sinon.stub(clientNotifyService, 'notifyClient').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  async function createIncident(db: any, data: any) {
    const service = new IncidentService(repoOptions(db));
    const rec = await service.create(data);
    await flush();
    return rec;
  }

  it('rings the CRM bell via dispatch(incident.created) with title + description', async () => {
    const db = buildDb(seedRelations);
    await createIncident(db, {
      title: 'Intrusión perimetral',
      description: 'Persona no autorizada',
      date: '2026-07-19T10:00:00Z',
      priority: 'media',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });

    const call = dispatchStub.getCalls().find((c) => c.args[0] === 'incident.created');
    assert.ok(call, 'incident.created was not dispatched');
    assert.strictEqual(call!.args[1].incidentTitle, 'Intrusión perimetral');
    assert.strictEqual(call!.args[1].description, 'Persona no autorizada');
    assert.strictEqual(call!.args[2].tenantId, TENANT, 'dispatch not tenant-scoped');
    assert.strictEqual(call!.args[2].sourceEntityType, 'incident');
  });

  it('notifies the owning client (incident.created) scoped to their account/site', async () => {
    const db = buildDb(seedRelations);
    const rec = await createIncident(db, {
      title: 'Incidente en sitio',
      description: 'Detalle',
      date: '2026-07-19T10:00:00Z',
      priority: 'media',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });

    assert.strictEqual(notifyClientStub.callCount, 1, 'client was not notified');
    const [, tenantArg, scope, ev] = notifyClientStub.firstCall.args;
    assert.strictEqual(tenantArg, TENANT);
    assert.strictEqual(scope.clientAccountId, 'ca-1', 'client notify not scoped to the owning client');
    assert.strictEqual(scope.postSiteId, 'ps-1');
    assert.strictEqual(ev.eventType, 'incident.created');
    assert.strictEqual(ev.sourceEntityId, String(rec.id));
  });

  it('HIGH severity (priority=alta) escalates the supervisor alert to CRITICAL', async () => {
    const db = buildDb(seedRelations);
    await createIncident(db, {
      title: 'Robo a mano armada',
      description: 'Arma de fuego',
      date: '2026-07-19T10:00:00Z',
      priority: 'alta',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });

    // One alert per resolved supervisor.
    assert.strictEqual(alertStub.callCount, 2, 'an alert must go to each supervisor');
    for (const call of alertStub.getCalls()) {
      assert.strictEqual(call.args[1].critical, true, 'high-severity incident must be critical');
      assert.strictEqual(call.args[1].tenantId, TENANT);
    }
    const userIds = alertStub.getCalls().map((c) => c.args[1].userId).sort();
    assert.deepStrictEqual(userIds, ['sup-1', 'sup-2']);
  });

  it('MEDIUM severity (priority=media) sends a NON-critical alert', async () => {
    const db = buildDb(seedRelations);
    await createIncident(db, {
      title: 'Observación de ronda',
      description: 'Luz fundida',
      date: '2026-07-19T10:00:00Z',
      priority: 'media',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });
    assert.ok(alertStub.callCount >= 1, 'supervisors should still be alerted');
    for (const call of alertStub.getCalls()) {
      assert.strictEqual(call.args[1].critical, false, 'medium incident must NOT be critical');
    }
  });

  it('the supervisor lookup is scoped to the incident post-site', async () => {
    const db = buildDb(seedRelations);
    await createIncident(db, {
      title: 'X',
      description: 'Y',
      date: '2026-07-19T10:00:00Z',
      priority: 'alta',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });
    const call = supIdsStub.firstCall;
    assert.ok(call, 'resolveSupervisorUserIds not called');
    assert.strictEqual(call.args[2].assignedPostSiteId, 'ps-1', 'supervisor lookup not scoped to the post-site');
  });

  it('a notify-channel failure never fails the incident create (best-effort)', async () => {
    const db = buildDb(seedRelations);
    dispatchStub.rejects(new Error('bell down'));
    alertStub.rejects(new Error('push down'));
    notifyClientStub.rejects(new Error('client notify down'));

    const rec = await createIncident(db, {
      title: 'Incidente resistente',
      description: 'Debe persistir',
      date: '2026-07-19T10:00:00Z',
      priority: 'alta',
      clientId: 'ca-1',
      postSiteId: 'ps-1',
      stationId: 'st-1',
    });
    // The row is committed regardless of the fan-out outcome.
    assert.ok(rec && rec.id, 'incident must be created even when every notify channel throws');
    assert.strictEqual(db.incident.calls.create.length, 1);
  });
});
