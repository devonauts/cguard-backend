/**
 * Unit tests — the per-tenant notification channel matrix actually SILENCES a
 * channel at dispatch time (Configuración → Notificaciones). crud-g09 covers
 * persisting the preference map; this covers the dispatcher HONORING it:
 *   - default prefs: dashboard ON, email OFF, sms OFF (a mapped event writes the
 *     in-app event but sends no email/SMS)
 *   - email switch ON  → sendMail fires to the role-resolved recipients
 *   - dashboard switch OFF → NO platform_events row is written (in-app silenced)
 *   - sms switch ON    → sendSmsForTenant fires to the resolved phones
 *   - a per-row default (check-in-out email ON) applies when unset
 *
 * REAL dispatcher + channelsForEvent + resolveRecipients against a fake db.
 * Only the outbound transports (mail/SMS/push) are stubbed.
 */
import assert from 'assert';
import sinon from 'sinon';

import { dispatch } from '../../../src/lib/notificationDispatcher';
import * as mailService from '../../../src/services/mailService';
import * as smsService from '../../../src/services/smsService';
import * as pushService from '../../../src/services/pushService';
import { makeModel } from './helpers';

const SUP_EMAIL = 'supervisor@tenant.ec';
const SUP_PHONE = '+593991112233';

/** Fake db just for the dispatcher: settings (prefs + branding), tenant, the
 *  active supervisor tenantUser, and a sequelize.query that records the
 *  platform_events INSERT. */
function buildDispatchDb(tenantId: string, notificationPreferences: any) {
  const queryCalls: any[] = [];
  const settings = makeModel('setting', [
    { id: tenantId, tenantId, notificationPreferences, emailBranding: null, logoUrl: '' },
  ]);
  const tenant = makeModel('tenant', [{ id: tenantId, name: 'Tenant A' }]);
  // One active supervisor (admin) with an email + phone, plus an archived user
  // who must NOT be notified.
  const tenantUser = makeModel('tenantUser', [
    { id: 'tu-1', tenantId, userId: 'u-sup', status: 'active', roles: ['admin'], user: { email: SUP_EMAIL, phoneNumber: SUP_PHONE } },
    { id: 'tu-2', tenantId, userId: 'u-old', status: 'inactive', roles: ['admin'], user: { email: 'old@tenant.ec', phoneNumber: '+000' } },
  ]);
  return {
    __queryCalls: queryCalls,
    settings,
    tenant,
    tenantUser,
    businessInfo: makeModel('businessInfo', []),
    user: makeModel('user', []),
    sequelize: {
      async query(sql: any, opts: any) {
        queryCalls.push({ sql: String(sql), opts });
        return [[], []];
      },
    },
  } as any;
}

function platformEventInserts(db: any) {
  return db.__queryCalls.filter((c: any) => /INSERT INTO platform_events/i.test(c.sql));
}

describe('op-comunicacion-notif · notification channel matrix silences channels at dispatch', () => {
  let mail: sinon.SinonStub;
  let sms: sinon.SinonStub;
  let push: sinon.SinonStub;

  beforeEach(() => {
    mail = sinon.stub(mailService, 'sendMail').resolves(undefined as any);
    sms = sinon.stub(smsService, 'sendSmsForTenant').resolves(undefined as any);
    push = sinon.stub(pushService, 'pushToUser').resolves(undefined as any);
  });
  afterEach(() => sinon.restore());

  it('default prefs: writes the in-app event but sends NO email and NO SMS', async () => {
    const db = buildDispatchDb('t-default', {}); // nothing saved → defaults
    await dispatch(
      'incident.created',
      { incidentTitle: 'Robo', guardName: 'Guardia A', siteName: 'Sitio 1', description: 'Detalle' },
      { database: db, tenantId: 't-default', sourceEntityType: 'incident', sourceEntityId: 'inc-1' },
    );
    assert.strictEqual(platformEventInserts(db).length, 1, 'in-app event should be written by default');
    assert.ok(mail.notCalled, 'email default is OFF — no mail must be sent');
    assert.ok(sms.notCalled, 'sms default is OFF — no SMS must be sent');
  });

  it('email switch ON → sends mail to the role-resolved supervisor recipients', async () => {
    const db = buildDispatchDb('t-email', { 'dispatch-updates': { email: true } });
    await dispatch(
      'incident.created',
      { incidentTitle: 'Robo', description: 'Detalle' },
      { database: db, tenantId: 't-email', sourceEntityType: 'incident', sourceEntityId: 'inc-2' },
    );
    assert.ok(mail.calledOnce, 'email switch ON must trigger sendMail');
    const to = mail.firstCall.args[0].to;
    const recipients = Array.isArray(to) ? to : [to];
    assert.ok(recipients.includes(SUP_EMAIL), 'active supervisor not among recipients');
    assert.ok(!recipients.includes('old@tenant.ec'), 'an inactive user must not be emailed');
  });

  it('dashboard switch OFF → NO in-app event row is written (panel silenced)', async () => {
    const db = buildDispatchDb('t-nodash', { 'dispatch-updates': { dashboard: false } });
    await dispatch(
      'incident.created',
      { incidentTitle: 'Robo', description: 'Detalle' },
      { database: db, tenantId: 't-nodash', sourceEntityType: 'incident', sourceEntityId: 'inc-3' },
    );
    assert.strictEqual(platformEventInserts(db).length, 0, 'panel switch OFF but an event was still stored');
  });

  it('sms switch ON → sends an SMS to the resolved phones', async () => {
    const db = buildDispatchDb('t-sms', { 'dispatch-updates': { sms: true } });
    await dispatch(
      'incident.created',
      { incidentTitle: 'Robo', description: 'Detalle' },
      { database: db, tenantId: 't-sms', sourceEntityType: 'incident', sourceEntityId: 'inc-4' },
    );
    assert.ok(sms.calledOnce, 'sms switch ON must trigger sendSmsForTenant');
    const phones = sms.firstCall.args[2];
    assert.ok(Array.isArray(phones) && phones.includes(SUP_PHONE), 'resolved phone missing from SMS send');
  });

  it('per-row default (check-in-out email ON) sends mail even when the tenant saved nothing', async () => {
    const db = buildDispatchDb('t-checkin', {}); // no saved prefs
    await dispatch(
      'guard.checkin',
      { guardName: 'Guardia A', siteName: 'Sitio 1', clockInTime: '08:00' },
      { database: db, tenantId: 't-checkin', sourceEntityType: 'guardShift', sourceEntityId: 'gs-1' },
    );
    assert.ok(mail.calledOnce, 'check-in email default is ON — mail should have been sent');
  });

  it('explicitly turning the check-in email OFF overrides the per-row default', async () => {
    const db = buildDispatchDb('t-checkin-off', { 'check-in-out': { email: false } });
    await dispatch(
      'guard.checkin',
      { guardName: 'Guardia A', siteName: 'Sitio 1', clockInTime: '08:00' },
      { database: db, tenantId: 't-checkin-off', sourceEntityType: 'guardShift', sourceEntityId: 'gs-2' },
    );
    assert.ok(mail.notCalled, 'saved email:false must beat the per-row default');
  });
});
