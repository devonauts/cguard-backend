/**
 * Unit tests — CRUD persistence fidelity for the g09-messaging group, part 1:
 *   notification            (NotificationRepository + NotificationService)
 *   notificationRecipient   (NotificationRecipientRepository)
 *   notificationPreferences (PUT /tenant/:tenantId/notification-preferences)
 *   emailPreferences        (PUT /tenant/:tenantId/email-preferences)
 *
 * Context: tenants report "things are not being saved". These tests call the
 * REAL repository/service/handler code against a Sequelize-shaped fake db and
 * assert (1) every writable field reaches the db write untouched, (2) updates
 * target the right row (id + tenantId), (3) db failures are NOT swallowed.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g09-messaging/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import NotificationRepository from '../../../src/database/repositories/notificationRepository';
import NotificationRecipientRepository from '../../../src/database/repositories/notificationRecipientRepository';
import NotificationService from '../../../src/services/notificationService';
import NotificationRecipientService from '../../../src/services/notificationRecipientService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error404 from '../../../src/errors/Error404';

import notificationPreferencesRoutes from '../../../src/api/notificationPreferences';
import emailPreferencesRoutes from '../../../src/api/emailPreferences';
import { EMAIL_CATALOG } from '../../../src/lib/emailCatalog';

import {
  TENANT,
  OTHER_TENANT,
  USER_ID,
  makeModel,
  makeRow,
  makeTx,
  repoOptions,
  fakeReq,
  fakeRes,
} from './helpers';

function buildDb(seed: {
  notifications?: any[];
  notificationRecipients?: any[];
  users?: any[];
  deviceIdInformations?: any[];
  settings?: any[];
} = {}) {
  const db: any = {
    notification: makeModel('notification', seed.notifications || []),
    notificationRecipient: makeModel('notificationRecipient', seed.notificationRecipients || []),
    user: makeModel('user', seed.users || []),
    tenantUser: makeModel('tenantUser', []),
    deviceIdInformation: makeModel('deviceIdInformation', seed.deviceIdInformations || []),
    settings: makeModel('settings', seed.settings || []),
    file: makeModel('file', []),
  };
  db.sequelize = {
    transaction: async () => makeTx(),
    query: async () => [[], []],
  };
  return db;
}

beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ notification ═══════════════════════════════════

// Every writable field the CRM notification form can send (repository
// whitelist + src/database/models/notification.ts).
const NOTIF_FULL = {
  title: 'Cambio de turno',
  body: 'El turno de la noche empieza a las 22:00',
  targetType: 'User',
  targetId: 'user-77',
  deliveryStatus: 'Pending',
  readStatus: true,
  importHash: 'hash-ntf-1',
};

describe('crud-g09 · notificationRepository.create', () => {
  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await NotificationRepository.create(
      { ...NOTIF_FULL, whoCreatedTheNotification: 'user-9', deviceId: ['dev-1'], imageUrl: [{ id: 'f-1' }] },
      repoOptions(db),
    );

    assert.strictEqual(db.notification.calls.create.length, 1);
    const written = db.notification.calls.create[0];
    for (const [k, v] of Object.entries(NOTIF_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.whoCreatedTheNotificationId, 'user-9');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('wires the deviceId M2M and the imageUrl file relation on create', async () => {
    const db = buildDb();
    const image = [{ id: 'f-1', name: 'noti.png' }];
    await NotificationRepository.create(
      { ...NOTIF_FULL, deviceId: ['dev-1', 'dev-2'], imageUrl: image },
      repoOptions(db),
    );
    const created = db.notification.rows[0];
    assert.deepStrictEqual(created.__setDeviceIdCalls[0], ['dev-1', 'dev-2']);
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'imageUrl');
    assert.ok(call, 'imageUrl file relation not written');
    assert.deepStrictEqual(call!.args[1], image);
  });

  it('a db failure on create PROPAGATES (not swallowed into a success)', async () => {
    const db = buildDb();
    db.notification.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => NotificationRepository.create({ ...NOTIF_FULL }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g09 · notificationRepository.update', () => {
  const EXISTING = {
    id: 'ntf-1',
    tenantId: TENANT,
    title: 'Viejo título',
    body: 'Viejo cuerpo',
    targetType: 'All',
    targetId: null,
    deliveryStatus: 'Pending',
    readStatus: false,
  };

  it('targets the right row (id + tenantId) and applies EVERY field of the patch', async () => {
    const db = buildDb({ notifications: [EXISTING] });
    const patch = {
      ...NOTIF_FULL,
      title: 'Título nuevo',
      body: 'Cuerpo nuevo',
      deliveryStatus: 'Delivered',
      readStatus: true,
      whoCreatedTheNotification: 'user-9',
      deviceId: ['dev-3'],
    };
    await NotificationRepository.update('ntf-1', patch, repoOptions(db));

    // The findOne that loaded the row must be tenant-scoped.
    const q = db.notification.calls.findOne[0];
    assert.strictEqual(q.where.id, 'ntf-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const row = db.notification.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    const applied = row.__updateCalls[0];
    for (const k of Object.keys(NOTIF_FULL)) {
      assert.deepStrictEqual(applied[k], (patch as any)[k], `field "${k}" missing from the update write`);
    }
    assert.strictEqual(applied.whoCreatedTheNotificationId, 'user-9');
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.deepStrictEqual(row.__setDeviceIdCalls[0], ['dev-3']);
    // And the row actually changed.
    assert.strictEqual(row.title, 'Título nuevo');
    assert.strictEqual(row.deliveryStatus, 'Delivered');
  });

  it('a PARTIAL update that omits whoCreatedTheNotification does NOT null the creator FK', async () => {
    // Fixed: whoCreatedTheNotificationId is now presence-guarded in update();
    // it used to be written as `data.whoCreatedTheNotification || null`
    // unconditionally, wiping the creator on any partial payload.
    const db = buildDb({
      notifications: [{ ...EXISTING, whoCreatedTheNotificationId: 'user-9' }],
    });
    await NotificationRepository.update('ntf-1', { readStatus: true }, repoOptions(db));

    const row = db.notification.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    assert.strictEqual(
      row.__updateCalls[0].whoCreatedTheNotificationId,
      undefined,
      'omitted whoCreatedTheNotification must not be written at all',
    );
    assert.strictEqual(row.whoCreatedTheNotificationId, 'user-9', 'creator FK was wiped by a partial update');
    assert.strictEqual(row.readStatus, true, 'the sent field must still apply');
  });

  it('an EXPLICIT whoCreatedTheNotification: null still clears the creator FK (legacy behavior kept)', async () => {
    const db = buildDb({
      notifications: [{ ...EXISTING, whoCreatedTheNotificationId: 'user-9' }],
    });
    await NotificationRepository.update(
      'ntf-1',
      { whoCreatedTheNotification: null },
      repoOptions(db),
    );
    assert.strictEqual(db.notification.rows[0].whoCreatedTheNotificationId, null);
  });

  it("REFUSES to update another tenant's notification (404, no write)", async () => {
    const db = buildDb({ notifications: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => NotificationRepository.update('ntf-1', { title: 'hack' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.notification.rows[0].__updateCalls.length, 0, 'must not write cross-tenant');
  });

  it('a db failure inside update PROPAGATES', async () => {
    const db = buildDb({ notifications: [EXISTING] });
    db.notification.rows[0].update = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => NotificationRepository.update('ntf-1', { title: 'x' }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g09 · NotificationService (transaction wrapper)', () => {
  it('create: filters deviceId to the tenant, persists, and commits', async () => {
    const db = buildDb({
      users: [{ id: 'user-9', tenantId: TENANT }],
      deviceIdInformations: [
        { id: 'dev-in', tenantId: TENANT },
        { id: 'dev-foreign', tenantId: OTHER_TENANT },
      ],
    });
    const service = new NotificationService(repoOptions(db));
    await service.create({
      ...NOTIF_FULL,
      whoCreatedTheNotification: 'user-9',
      deviceId: ['dev-in', 'dev-foreign'],
    });
    assert.strictEqual(db.notification.calls.create.length, 1);
    const written = db.notification.calls.create[0];
    assert.strictEqual(written.title, NOTIF_FULL.title);
    assert.strictEqual(written.whoCreatedTheNotificationId, 'user-9');
    // Cross-tenant device id must be stripped, in-tenant one kept.
    assert.deepStrictEqual(db.notification.rows[0].__setDeviceIdCalls[0], ['dev-in']);
  });

  it('create: a repository failure rolls back and RE-THROWS (never a fake success)', async () => {
    const db = buildDb();
    let tx: any;
    db.sequelize.transaction = async () => (tx = makeTx());
    db.notification.create = async () => {
      throw new Error('DB down');
    };
    const service = new NotificationService(repoOptions(db));
    await assert.rejects(() => service.create({ ...NOTIF_FULL }), /DB down/);
    assert.strictEqual(tx.rolledBack, true, 'transaction must be rolled back');
    assert.strictEqual(tx.committed, false);
  });

  it('update: a partial payload (readStatus only) does not wipe the creator FK through the service', async () => {
    // Fixed: service.update used to unconditionally run
    // UserRepository.filterIdInTenant(data.whoCreatedTheNotification), turning
    // an OMITTED value into null and wiping the FK despite the repo guard.
    const db = buildDb({
      notifications: [
        { id: 'ntf-1', tenantId: TENANT, title: 'x', whoCreatedTheNotificationId: 'user-9' },
      ],
      users: [{ id: 'user-9', tenantId: TENANT }],
    });
    const service = new NotificationService(repoOptions(db));
    await service.update('ntf-1', { readStatus: true });
    const row = db.notification.rows[0];
    assert.strictEqual(row.whoCreatedTheNotificationId, 'user-9', 'creator FK was wiped by a partial service update');
    assert.strictEqual(row.readStatus, true);
  });

  it('update: a repository failure rolls back and RE-THROWS', async () => {
    const db = buildDb({ notifications: [{ id: 'ntf-1', tenantId: TENANT, title: 'x' }] });
    let tx: any;
    db.sequelize.transaction = async () => (tx = makeTx());
    db.notification.rows[0].update = async () => {
      throw new Error('DB down');
    };
    const service = new NotificationService(repoOptions(db));
    await assert.rejects(() => service.update('ntf-1', { title: 'y' }), /DB down/);
    assert.strictEqual(tx.rolledBack, true);
  });
});

// ═══════════════════════ notificationRecipient ═══════════════════════════════

const RECIP_FULL = {
  recipientId: 'user-55',
  readStatus: true,
  deliveryStatus: 'Delivered',
  dateDelivered: new Date('2026-07-01T10:00:00Z'),
  importHash: 'hash-rec-1',
};

describe('crud-g09 · notificationRecipientRepository.create', () => {
  it('persists EVERY writable field + the notification FK (field fidelity)', async () => {
    const db = buildDb();
    await NotificationRecipientRepository.create(
      { ...RECIP_FULL, notification: 'ntf-1' },
      repoOptions(db),
    );
    assert.strictEqual(db.notificationRecipient.calls.create.length, 1);
    const written = db.notificationRecipient.calls.create[0];
    for (const [k, v] of Object.entries(RECIP_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.notificationId, 'ntf-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('a db failure on create PROPAGATES', async () => {
    const db = buildDb();
    db.notificationRecipient.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => NotificationRecipientRepository.create({ ...RECIP_FULL }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g09 · notificationRecipientRepository.update', () => {
  const EXISTING = {
    id: 'rec-1',
    tenantId: TENANT,
    recipientId: 'user-55',
    readStatus: false,
    deliveryStatus: 'Pending',
    dateDelivered: null,
    notificationId: 'ntf-1',
  };

  it('targets the right row (id + tenantId) and applies the whole patch', async () => {
    const db = buildDb({ notificationRecipients: [EXISTING] });
    const patch = { ...RECIP_FULL, notification: 'ntf-2' };
    await NotificationRecipientRepository.update('rec-1', patch, repoOptions(db));

    const q = db.notificationRecipient.calls.findOne[0];
    assert.strictEqual(q.where.id, 'rec-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const row = db.notificationRecipient.rows[0];
    const applied = row.__updateCalls[0];
    for (const k of Object.keys(RECIP_FULL)) {
      assert.deepStrictEqual(applied[k], (patch as any)[k], `field "${k}" missing from the update write`);
    }
    assert.strictEqual(applied.notificationId, 'ntf-2');
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual(row.readStatus, true);
    assert.strictEqual(row.deliveryStatus, 'Delivered');
  });

  it('a PARTIAL update (readStatus only) does NOT detach the row from its notification', async () => {
    // Fixed: notificationId is now presence-guarded in update(); it used to be
    // written as `data.notification || null` unconditionally, detaching the
    // recipient row from its notification on any partial payload.
    const db = buildDb({ notificationRecipients: [EXISTING] });
    await NotificationRecipientRepository.update('rec-1', { readStatus: true }, repoOptions(db));

    const row = db.notificationRecipient.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    assert.strictEqual(
      row.__updateCalls[0].notificationId,
      undefined,
      'omitted notification must not be written at all',
    );
    assert.strictEqual(row.notificationId, 'ntf-1', 'notification FK was wiped by a partial update');
    assert.strictEqual(row.readStatus, true, 'the sent field must still apply');
  });

  it('service update: a partial payload keeps the notification FK (no filterIdInTenant(undefined) wipe)', async () => {
    // Fixed: notificationRecipientService.update used to unconditionally run
    // NotificationRepository.filterIdInTenant(data.notification), turning an
    // OMITTED value into null and detaching the row despite the repo guard.
    const db = buildDb({
      notificationRecipients: [EXISTING],
      notifications: [{ id: 'ntf-1', tenantId: TENANT, title: 't' }],
    });
    const service = new NotificationRecipientService(repoOptions(db));
    await service.update('rec-1', { readStatus: true });
    const row = db.notificationRecipient.rows[0];
    assert.strictEqual(row.notificationId, 'ntf-1', 'notification FK was wiped by a partial service update');
    assert.strictEqual(row.readStatus, true);
  });

  it("REFUSES to update another tenant's row (404, no write)", async () => {
    const db = buildDb({ notificationRecipients: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => NotificationRecipientRepository.update('rec-1', { readStatus: true }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.notificationRecipient.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════ notificationPreferences (settings JSON) ═════════════════

function mountRoutes(mod: (app: any) => void) {
  const routes: Record<string, any> = {};
  const app = {
    get: (p: string, h: any) => (routes[`GET ${p}`] = h),
    put: (p: string, h: any) => (routes[`PUT ${p}`] = h),
    post: (p: string, h: any) => (routes[`POST ${p}`] = h),
    delete: (p: string, h: any) => (routes[`DELETE ${p}`] = h),
  };
  mod(app as any);
  return routes;
}

describe('crud-g09 · PUT /notification-preferences', () => {
  const routes = mountRoutes(notificationPreferencesRoutes);
  const put = routes['PUT /tenant/:tenantId/notification-preferences'];

  it('persists the sanitized channel map onto settings.notificationPreferences', async () => {
    const db = buildDb();
    const req = fakeReq(db, {
      params: { tenantId: TENANT },
      body: {
        data: {
          preferences: {
            'check-in-out': { dashboard: 1, email: true, sms: 0 }, // truthy coercion
            'dispatch-updates': { dashboard: false, email: false, sms: true },
            'garbage-row': 'not-an-object', // must be dropped
          },
        },
      },
    });
    const res = fakeRes();
    await put(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    // The settings row was created for the tenant and updated with ONLY the
    // notificationPreferences column + updatedById.
    const row = db.settings.rows[0];
    assert.strictEqual(row.id, TENANT);
    const applied = row.__updateCalls[0];
    assert.deepStrictEqual(applied.notificationPreferences, {
      'check-in-out': { dashboard: true, email: true, sms: false },
      'dispatch-updates': { dashboard: false, email: false, sms: true },
    });
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual('theme' in applied, false, 'must not disturb other settings columns');
    // And the response echoes what is now in the db.
    assert.deepStrictEqual(res.body.preferences['check-in-out'], { dashboard: true, email: true, sms: false });
  });

  it('a db failure surfaces as an error response (NOT a fake 200)', async () => {
    const db = buildDb();
    db.settings.findOrCreate = async () => {
      throw new Error('DB down');
    };
    const req = fakeReq(db, { params: { tenantId: TENANT }, body: { data: { preferences: {} } } });
    const res = fakeRes();
    await put(req, res);
    assert.notStrictEqual(res.statusCode, 200, 'db failure must not return success');
  });
});

// ═══════════════════════ emailPreferences (settings JSON) ════════════════════

describe('crud-g09 · PUT /email-preferences', () => {
  const routes = mountRoutes(emailPreferencesRoutes);
  const put = routes['PUT /tenant/:tenantId/email-preferences'];

  const unlockedKeys = EMAIL_CATALOG.filter((i) => !i.locked).map((i) => i.key);
  const lockedKey = (EMAIL_CATALOG.find((i) => i.locked) || {}).key as string;

  it('persists EVERY unlocked toggle, ignores locked/unknown keys, keeps existing values', async () => {
    const db = buildDb({
      settings: [{ id: TENANT, tenantId: TENANT, emailPreferences: { [unlockedKeys[1]]: false } }],
    });
    const incoming: any = { [unlockedKeys[0]]: false, unknownKey: false };
    if (lockedKey) incoming[lockedKey] = false; // must be refused
    const req = fakeReq(db, {
      params: { tenantId: TENANT },
      body: { data: { preferences: incoming } },
    });
    const res = fakeRes();
    await put(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.settings.rows[0];
    const applied = row.__updateCalls[0];
    assert.strictEqual(applied.emailPreferences[unlockedKeys[0]], false, 'sent toggle was dropped');
    assert.strictEqual(applied.emailPreferences[unlockedKeys[1]], false, 'pre-existing toggle was lost');
    assert.strictEqual(lockedKey in applied.emailPreferences, false, 'locked key must never be stored');
    assert.strictEqual('unknownKey' in applied.emailPreferences, false, 'unknown key must be dropped');
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual('emailBranding' in applied, false, 'branding untouched when not sent');
    // Enforcement view reflects the save.
    assert.strictEqual(res.body.preferences[unlockedKeys[0]], false);
    if (lockedKey) assert.strictEqual(res.body.preferences[lockedKey], true, 'locked emails always on');
  });

  it('persists branding (normalized safe hex) when provided', async () => {
    const db = buildDb({ settings: [{ id: TENANT, tenantId: TENANT }] });
    const req = fakeReq(db, {
      params: { tenantId: TENANT },
      body: { data: { preferences: {}, branding: { brandColor: '#ff8800', headerColor: 'javascript:alert(1)' } } },
    });
    const res = fakeRes();
    await put(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const applied = db.settings.rows[0].__updateCalls[0];
    assert.ok(applied.emailBranding, 'emailBranding was not written');
    assert.strictEqual(String(applied.emailBranding.brandColor).toLowerCase(), '#ff8800');
    // The invalid header color must fall back to a safe default hex, never persist raw junk.
    assert.match(String(applied.emailBranding.headerColor), /^#[0-9a-fA-F]{3,8}$/);
  });

  it('a db failure on save surfaces as an error response', async () => {
    const db = buildDb({ settings: [{ id: TENANT, tenantId: TENANT }] });
    db.settings.rows[0].update = async () => {
      throw new Error('DB down');
    };
    const req = fakeReq(db, {
      params: { tenantId: TENANT },
      body: { data: { preferences: {} } },
    });
    const res = fakeRes();
    await put(req, res);
    assert.notStrictEqual(res.statusCode, 200, 'db failure must not return success');
  });
});
