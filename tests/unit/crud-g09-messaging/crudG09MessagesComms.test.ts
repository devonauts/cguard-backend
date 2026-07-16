/**
 * Unit tests — CRUD persistence fidelity for the g09-messaging group, part 2:
 *   message        (messageService: conversations, sendMessage, receipts,
 *                   groups, markRead, per-user hide + the PATCH/DELETE handlers)
 *   communication  (communicationSettingsService: settings JSON, wallet;
 *                   communicationLogService: delivery log writes)
 *
 * Same fake-db harness as part 1 (see ./helpers). The REAL service/handler
 * code runs against it; tests assert every writable field reaches the db
 * write, updates hit the right row, and db failures are not swallowed.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g09-messaging/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import Sequelize from 'sequelize';

// Pre-load the modules sendMessage lazily requires for its fire-and-forget
// notification fan-out (pushService → firebase graph, platformEventStore →
// realtime/socket.io). ts-node type-checks each graph on first require; paying
// that cost at file load keeps it out of the first test's 20s timeout.
import '../../../src/services/pushService';
import '../../../src/lib/platformEventStore';

import {
  getOrCreateConversation,
  sendMessage,
  createGroupConversation,
  markRead,
  hideConversationForUser,
} from '../../../src/services/messageService';
import {
  messageCreate,
  messagePatch,
  messageDelete,
} from '../../../src/api/message/messageEndpoints';
import { decryptBody, encryptBody } from '../../../src/lib/messageCrypto';
import {
  saveSettings,
  debitWallet,
  creditWallet,
  creditWalletFromRecharge,
  DEFAULT_SETTINGS,
} from '../../../src/services/communication/communicationSettingsService';
import {
  log as commLog,
  updateStatusByProviderMessageId,
} from '../../../src/services/communication/communicationLogService';
import { settingsPut } from '../../../src/api/communication/communicationEndpoints';

import {
  TENANT,
  USER_ID,
  makeModel,
  makeRow,
  makeTx,
  fakeReq,
  fakeRes,
  flush,
} from './helpers';

const Op = Sequelize.Op;

function buildDb(seed: {
  conversations?: any[];
  messages?: any[];
  receipts?: any[];
  participants?: any[];
  hidden?: any[];
  securityGuards?: any[];
  clientAccounts?: any[];
  users?: any[];
  settings?: any[];
  wallets?: any[];
  commLogs?: any[];
} = {}) {
  const db: any = {
    Sequelize,
    message: makeModel('message', seed.messages || []),
    messageConversation: makeModel('messageConversation', seed.conversations || []),
    messageConversationParticipant: makeModel('messageConversationParticipant', seed.participants || []),
    messageReceipt: makeModel('messageReceipt', seed.receipts || []),
    messageHidden: makeModel('messageHidden', seed.hidden || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    user: makeModel('user', seed.users || []),
    settings: makeModel('settings', seed.settings || []),
    communicationWallet: makeModel('communicationWallet', seed.wallets || []),
    communicationLog: makeModel('communicationLog', seed.commLogs || []),
    communicationProviderRate: makeModel('communicationProviderRate', []),
    deviceIdInformation: makeModel('deviceIdInformation', []),
  };
  db.__txs = [] as any[];
  db.sequelize = {
    transaction: async () => {
      const tx = makeTx();
      db.__txs.push(tx);
      return tx;
    },
    query: async () => [[], []],
  };
  // messageReceipt fan-out uses bulkCreate when available — provide it so the
  // production path (one INSERT) is what gets exercised.
  db.messageReceipt.bulkCreate = async (rows: any[]) => {
    for (const r of rows) await db.messageReceipt.create(r);
    return rows;
  };
  return db;
}

const GUARD = { id: 'sg-1', guardId: 'guard-user-1', fullName: 'Juan Pérez', tenantId: TENANT };

// ═══════════════════════ conversations (message) ═════════════════════════════

describe('crud-g09 · getOrCreateConversation', () => {
  it('creates a direct guard thread with EVERY denormalized field', async () => {
    const db = buildDb({ securityGuards: [GUARD] });
    await getOrCreateConversation(db, TENANT, USER_ID, {
      recipientType: 'guard',
      recipientId: 'sg-1',
      subject: 'Consigna nocturna',
      isOneWay: true,
    });
    assert.strictEqual(db.messageConversation.calls.create.length, 1);
    const written = db.messageConversation.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.kind, 'direct');
    assert.strictEqual(written.recipientType, 'guard');
    assert.strictEqual(written.recipientUserId, 'guard-user-1');
    assert.strictEqual(written.recipientSecurityGuardId, 'sg-1');
    assert.strictEqual(written.recipientClientAccountId, null);
    assert.strictEqual(written.subject, 'Consigna nocturna');
    assert.strictEqual(written.isOneWay, true);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('accepts the guard USER id too (autocomplete sends user ids)', async () => {
    const db = buildDb({ securityGuards: [GUARD] });
    await getOrCreateConversation(db, TENANT, USER_ID, { recipientType: 'guard', recipientId: 'guard-user-1' });
    assert.strictEqual(db.messageConversation.calls.create[0].recipientSecurityGuardId, 'sg-1');
  });

  it('REUSES the existing direct thread instead of creating a duplicate', async () => {
    const db = buildDb({
      securityGuards: [GUARD],
      conversations: [{
        id: 'conv-1', tenantId: TENANT, kind: 'direct', recipientType: 'guard',
        recipientSecurityGuardId: 'sg-1', archived: false,
      }],
    });
    const convo = await getOrCreateConversation(db, TENANT, USER_ID, { recipientType: 'guard', recipientId: 'sg-1' });
    assert.strictEqual(convo.id, 'conv-1');
    assert.strictEqual(db.messageConversation.calls.create.length, 0);
  });

  it('rejects a recipient that does not belong to the tenant (400, no create)', async () => {
    const db = buildDb({ securityGuards: [{ ...GUARD, tenantId: 'tenant-B' }] });
    await assert.rejects(
      () => getOrCreateConversation(db, TENANT, USER_ID, { recipientType: 'guard', recipientId: 'sg-1' }),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.messageConversation.calls.create.length, 0);
  });
});

// ═══════════════════════════ sendMessage ═════════════════════════════════════

function directConversation(extra: any = {}) {
  return makeRow({
    id: 'conv-1',
    tenantId: TENANT,
    kind: 'direct',
    recipientType: 'guard',
    recipientUserId: 'guard-user-1',
    recipientSecurityGuardId: 'sg-1',
    isOneWay: false,
    createdById: USER_ID,
    ...extra,
  });
}

describe('crud-g09 · sendMessage', () => {
  it('persists the message (encrypted body, sanitized attachments, ALL fields) + receipt + conversation denorm', async () => {
    const db = buildDb({ users: [{ id: USER_ID, fullName: 'Operador' }] });
    const conversation = directConversation();
    const longName = 'x'.repeat(250);

    const message = await sendMessage(db, TENANT, {
      conversation,
      senderUserId: USER_ID,
      senderType: 'staff',
      body: 'Hola equipo',
      clientMsgId: 'cmid-1',
      attachments: [
        { url: 'https://cdn.x/img.png', type: 'weird' as any, name: longName, sizeInBytes: '5' as any },
        { url: '   ' }, // no real url → dropped
        { type: 'image' } as any, // no url → dropped
      ],
    });
    await flush();

    // Message row: every field, body encrypted at rest.
    assert.strictEqual(db.message.calls.create.length, 1);
    const written = db.message.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.conversationId, 'conv-1');
    assert.strictEqual(written.senderUserId, USER_ID);
    assert.strictEqual(written.senderType, 'staff');
    assert.ok(String(written.body).startsWith('enc1:'), 'body must be encrypted at rest');
    assert.strictEqual(decryptBody(written.body), 'Hola equipo');
    assert.strictEqual(written.clientMsgId, 'cmid-1');
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    assert.strictEqual(written.attachments.length, 1, 'malformed attachments must be dropped, valid kept');
    assert.deepStrictEqual(written.attachments[0], {
      url: 'https://cdn.x/img.png',
      type: 'image', // unknown type coerced
      name: longName.slice(0, 200),
      sizeInBytes: null, // non-number dropped
    });

    // Receipt fan-out: the OTHER participant of the direct thread.
    assert.strictEqual(db.messageReceipt.calls.create.length, 1);
    const receipt = db.messageReceipt.calls.create[0];
    assert.strictEqual(receipt.tenantId, TENANT);
    assert.strictEqual(receipt.conversationId, 'conv-1');
    assert.strictEqual(receipt.recipientUserId, 'guard-user-1');
    assert.strictEqual(receipt.deliveryStatus, 'pending');
    assert.ok(receipt.messageId, 'receipt must reference the message');

    // Conversation denorm updated in the same transaction.
    const convPatch = conversation.__updateCalls[0];
    assert.ok(convPatch.lastMessageAt, 'lastMessageAt not stamped');
    assert.strictEqual(decryptBody(convPatch.lastMessagePreview), 'Hola equipo');
    assert.strictEqual(convPatch.updatedById, USER_ID);

    // Transaction committed; sender got the plaintext echo.
    assert.strictEqual(db.__txs[0].committed, true);
    assert.strictEqual(message.body, 'Hola equipo');
  });

  it('is idempotent on clientMsgId (a retry returns the existing row, NO second insert)', async () => {
    const db = buildDb({
      messages: [{
        id: 'msg-1', tenantId: TENANT, senderUserId: USER_ID,
        clientMsgId: 'cmid-1', body: encryptBody('previo'),
      }],
    });
    const conversation = directConversation();
    const message = await sendMessage(db, TENANT, {
      conversation, senderUserId: USER_ID, senderType: 'staff', body: 'reintento', clientMsgId: 'cmid-1',
    });
    assert.strictEqual(db.message.calls.create.length, 0, 'retry must not insert a duplicate');
    assert.strictEqual(message.id, 'msg-1');
    assert.strictEqual(message.body, 'previo');
  });

  it('rejects an empty message (400) without writing anything', async () => {
    const db = buildDb();
    await assert.rejects(
      () => sendMessage(db, TENANT, { conversation: directConversation(), senderUserId: USER_ID, senderType: 'staff', body: '   ' }),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.message.calls.create.length, 0);
  });

  it('rejects a guard reply on a one-way conversation (400)', async () => {
    const db = buildDb();
    await assert.rejects(
      () => sendMessage(db, TENANT, {
        conversation: directConversation({ isOneWay: true }),
        senderUserId: 'guard-user-1', senderType: 'guard', body: 'hola',
      }),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.message.calls.create.length, 0);
  });

  it('a db failure rolls back the transaction and RE-THROWS (no fake success)', async () => {
    const db = buildDb();
    db.message.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => sendMessage(db, TENANT, { conversation: directConversation(), senderUserId: USER_ID, senderType: 'staff', body: 'hola' }),
      /DB down/,
    );
    assert.strictEqual(db.__txs[0].rolledBack, true, 'transaction must be rolled back');
  });
});

// ═══════════════════════ groups / read state / hide ══════════════════════════

describe('crud-g09 · createGroupConversation', () => {
  it('persists the group with ALL fields + the creator as an admin participant', async () => {
    const db = buildDb();
    await createGroupConversation(db, TENANT, USER_ID, {
      name: '  Grupo Norte  '.repeat(1), // stored as-is (sliced at 200)
      anchorType: 'postSite',
      anchorId: 'ps-1',
      isOneWay: true,
      avatarUrl: 'https://cdn.x/avatar.png',
    });
    const written = db.messageConversation.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.kind, 'group');
    assert.strictEqual(written.subject, '  Grupo Norte  ');
    assert.strictEqual(written.anchorType, 'postSite');
    assert.strictEqual(written.anchorId, 'ps-1');
    assert.strictEqual(written.isOneWay, true);
    assert.strictEqual(written.avatarUrl, 'https://cdn.x/avatar.png');
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);

    const part = db.messageConversationParticipant.calls.create[0];
    assert.strictEqual(part.tenantId, TENANT);
    assert.strictEqual(part.userId, USER_ID);
    assert.strictEqual(part.participantType, 'staff');
    assert.strictEqual(part.role, 'admin');
    assert.strictEqual(part.source, 'manual');
  });
});

describe('crud-g09 · markRead', () => {
  it('targets ONLY the viewer’s unread receipts in the conversation and flips them read', async () => {
    const db = buildDb({
      receipts: [
        { id: 'r-1', tenantId: TENANT, conversationId: 'conv-1', recipientUserId: USER_ID, deliveryStatus: 'pending' },
        { id: 'r-2', tenantId: TENANT, conversationId: 'conv-1', recipientUserId: USER_ID, deliveryStatus: 'read' },
        { id: 'r-3', tenantId: TENANT, conversationId: 'conv-1', recipientUserId: 'otro', deliveryStatus: 'pending' },
      ],
    });
    const n = await markRead(db, TENANT, 'conv-1', USER_ID);
    assert.strictEqual(n, 1, 'only the viewer’s unread receipt should update');
    const call = db.messageReceipt.calls.update[0];
    assert.strictEqual(call.patch.deliveryStatus, 'read');
    assert.ok(call.patch.readAt instanceof Date, 'readAt must be stamped');
    assert.strictEqual(call.where.tenantId, TENANT);
    assert.strictEqual(call.where.conversationId, 'conv-1');
    assert.strictEqual(call.where.recipientUserId, USER_ID);
    assert.strictEqual(call.where.deliveryStatus[Op.ne], 'read');
    const row = db.messageReceipt.rows.find((r: any) => r.id === 'r-1');
    assert.strictEqual(row.deliveryStatus, 'read');
  });
});

describe('crud-g09 · hideConversationForUser', () => {
  it('creates the per-user hide row with tenant/user/conversation + hiddenAt', async () => {
    const db = buildDb();
    await hideConversationForUser(db, TENANT, USER_ID, 'conv-1');
    const written = db.messageHidden.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.userId, USER_ID);
    assert.strictEqual(written.conversationId, 'conv-1');
    assert.ok(written.hiddenAt instanceof Date);
  });

  it('re-hiding refreshes hiddenAt on the SAME row (no duplicate)', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const db = buildDb({ hidden: [{ id: 'h-1', tenantId: TENANT, userId: USER_ID, conversationId: 'conv-1', hiddenAt: old }] });
    await hideConversationForUser(db, TENANT, USER_ID, 'conv-1');
    assert.strictEqual(db.messageHidden.calls.create.length, 0);
    assert.ok(db.messageHidden.rows[0].hiddenAt > old, 'hiddenAt must be refreshed');
  });
});

// ═══════════════════════ message express handlers ════════════════════════════

describe('crud-g09 · messagePatch handler (archive/rename/one-way)', () => {
  it('applies EVERY provided flag + the trimmed group name to the conversation row', async () => {
    const db = buildDb({
      conversations: [{ id: 'conv-9', tenantId: TENANT, kind: 'group', subject: 'Viejo', archived: false, isOneWay: false }],
    });
    const req = fakeReq(db, {
      params: { conversationId: 'conv-9' },
      body: { data: { name: '  Nuevo nombre  ', isOneWay: true, archived: true } },
    });
    const res = fakeRes();
    await messagePatch(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.messageConversation.rows[0];
    const applied = row.__updateCalls[0];
    assert.strictEqual(applied.subject, 'Nuevo nombre', 'rename dropped');
    assert.strictEqual(applied.isOneWay, true);
    assert.strictEqual(applied.archived, true);
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('404s (does not write) when the conversation belongs to another tenant', async () => {
    const db = buildDb({
      conversations: [{ id: 'conv-9', tenantId: 'tenant-B', kind: 'group', subject: 'Ajeno' }],
    });
    const req = fakeReq(db, { params: { conversationId: 'conv-9' }, body: { data: { archived: true } } });
    const res = fakeRes();
    await messagePatch(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.messageConversation.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g09 · messageDelete handler', () => {
  it('soft-deletes receipts + messages + the conversation (tenant-scoped)', async () => {
    const db = buildDb({
      conversations: [{ id: 'conv-9', tenantId: TENANT, kind: 'direct', recipientType: 'guard' }],
      messages: [{ id: 'm-1', tenantId: TENANT, conversationId: 'conv-9', body: 'x' }],
      receipts: [{ id: 'r-1', tenantId: TENANT, conversationId: 'conv-9', recipientUserId: 'u' }],
    });
    const req = fakeReq(db, { params: { conversationId: 'conv-9' } });
    const res = fakeRes();
    await messageDelete(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(db.messageReceipt.calls.destroy[0].where, { tenantId: TENANT, conversationId: 'conv-9' });
    assert.deepStrictEqual(db.message.calls.destroy[0].where, { tenantId: TENANT, conversationId: 'conv-9' });
    assert.strictEqual(db.messageConversation.rows[0].__destroyed, true);
    assert.deepStrictEqual(res.body, { id: 'conv-9', deleted: true });
  });
});

describe('crud-g09 · messageCreate handler', () => {
  it('400s when recipientType/recipientId are missing (no silent success)', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { data: { body: 'hola' } } });
    const res = fakeRes();
    await messageCreate(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.messageConversation.calls.create.length, 0);
    assert.strictEqual(db.message.calls.create.length, 0);
  });
});

// ═══════════════════ communication · settings + wallet ═══════════════════════

describe('crud-g09 · communication saveSettings', () => {
  // Every settings key the Configuración → Comunicaciones UI can send.
  const FULL_PATCH = {
    push_enabled: false,
    whatsapp_enabled: true,
    sms_enabled: false,
    email_enabled: false,
    whatsapp_provider: 'meta',
    sms_provider: 'twilio',
    critical_alert_sms_fallback: false,
    otp_preferred_channel: 'sms',
    wallet_required_for_paid_channels: false,
    low_balance_threshold: 1000,
    allow_negative_communications_balance: true,
    default_country_code: '+1',
    timezone: 'America/Guayaquil',
    whatsapp_shift_reminders: true,
    whatsapp_incidents: false,
    sms_critical: false,
  } as any;

  it('persists EVERY settings key of the patch and keeps unrelated stored keys', async () => {
    const db = buildDb({
      settings: [{ id: TENANT, tenantId: TENANT, communicationSettings: { sms_enabled: true, custom_note: 'keep-me' } }],
    });
    const merged = await saveSettings(db, TENANT, { ...FULL_PATCH });
    const row = db.settings.rows[0];
    const written = row.__updateCalls[0].communicationSettings;
    for (const [k, v] of Object.entries(FULL_PATCH)) {
      assert.deepStrictEqual(written[k], v, `settings key "${k}" was dropped or altered`);
      assert.deepStrictEqual((merged as any)[k], v, `merged result lost "${k}"`);
    }
    assert.strictEqual(written.custom_note, 'keep-me', 'unrelated stored key must survive the merge');
    // sanity: the full-patch coverage matches the service's own defaults catalog
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      assert.ok(k in FULL_PATCH, `test patch is missing settings key "${k}" — add it`);
    }
  });

  it('creates the settings row when missing (findOrCreate keyed by tenant)', async () => {
    const db = buildDb();
    await saveSettings(db, TENANT, { sms_enabled: false });
    assert.strictEqual(db.settings.calls.findOrCreate.length, 1);
    assert.strictEqual(db.settings.calls.findOrCreate[0].where.id, TENANT);
    assert.strictEqual(db.settings.rows[0].__updateCalls[0].communicationSettings.sms_enabled, false);
  });

  it('settingsPut handler surfaces a db failure as an error response', async () => {
    const db = buildDb();
    db.settings.findOrCreate = async () => {
      throw new Error('DB down');
    };
    const req = fakeReq(db, { body: { data: { sms_enabled: false } } });
    const res = fakeRes();
    await settingsPut(req, res);
    assert.notStrictEqual(res.statusCode, 200, 'db failure must not return success');
  });
});

describe('crud-g09 · communication wallet', () => {
  it('debitWallet refuses an insufficient balance (ok:false, NO write)', async () => {
    const db = buildDb({ wallets: [{ id: 'w-1', tenantId: TENANT, balanceCents: 100 }] });
    const r = await debitWallet(db, TENANT, 200);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'insufficient_balance');
    assert.strictEqual(db.communicationWallet.rows[0].__updateCalls.length, 0, 'must not write on refusal');
  });

  it('debitWallet persists the debited balance atomically', async () => {
    const db = buildDb({ wallets: [{ id: 'w-1', tenantId: TENANT, balanceCents: 500 }] });
    const r = await debitWallet(db, TENANT, 200);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.balanceAfterCents, 300);
    assert.strictEqual(db.communicationWallet.rows[0].__updateCalls[0].balanceCents, 300);
    assert.strictEqual(db.__txs[db.__txs.length - 1].committed, true);
  });

  it('creditWallet persists the credited balance', async () => {
    const db = buildDb({ wallets: [{ id: 'w-1', tenantId: TENANT, balanceCents: 100 }] });
    const r = await creditWallet(db, TENANT, 400);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.communicationWallet.rows[0].balanceCents, 500);
  });

  it('creditWalletFromRecharge writes the balance AND a full ledger row, idempotently', async () => {
    const db = buildDb({ wallets: [{ id: 'w-1', tenantId: TENANT, balanceCents: 0 }] });
    const r1 = await creditWalletFromRecharge(db, TENANT, 1500, {
      reference: 'cs_test_123', description: 'Recarga', currency: 'usd',
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.balanceAfterCents, 1500);

    const ledger = db.communicationLog.calls.create[0];
    assert.strictEqual(ledger.tenantId, TENANT);
    assert.strictEqual(ledger.channel, 'wallet');
    assert.strictEqual(ledger.provider, 'stripe');
    assert.strictEqual(ledger.messageType, 'wallet_recharge');
    assert.strictEqual(ledger.status, 'delivered');
    assert.strictEqual(ledger.providerMessageId, 'cs_test_123');
    assert.strictEqual(ledger.billedAmountCents, -1500);
    assert.strictEqual(ledger.currency, 'USD');
    assert.strictEqual(ledger.providerResponse.creditedCents, 1500);
    assert.strictEqual(ledger.providerResponse.balanceAfterCents, 1500);

    // A webhook retry with the same reference must NOT double-credit.
    const r2 = await creditWalletFromRecharge(db, TENANT, 1500, { reference: 'cs_test_123' });
    assert.strictEqual(r2.duplicated, true);
    assert.strictEqual(db.communicationWallet.rows[0].balanceCents, 1500, 'balance must not be credited twice');
    assert.strictEqual(db.communicationLog.calls.create.length, 1, 'no second ledger row');
  });

  it('creditWalletFromRecharge PROPAGATES a db failure (rollback, no swallow)', async () => {
    const db = buildDb({ wallets: [{ id: 'w-1', tenantId: TENANT, balanceCents: 0 }] });
    db.communicationLog.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => creditWalletFromRecharge(db, TENANT, 1000, { reference: 'cs_x' }),
      /DB down/,
    );
    assert.strictEqual(db.__txs[db.__txs.length - 1].rolledBack, true);
  });
});

// ═══════════════════ communication · delivery log ════════════════════════════

describe('crud-g09 · communicationLogService', () => {
  it('log() persists EVERY LogInput field + the status timestamp', async () => {
    const db = buildDb();
    const input = {
      tenantId: TENANT,
      userId: 'user-7',
      recipient: '+593983212345',
      channel: 'sms' as any,
      provider: 'twilio',
      messageType: 'incident_alert' as any,
      status: 'delivered' as any,
      providerMessageId: 'SM123',
      providerResponse: { sid: 'SM123' },
      errorMessage: null,
      costEstimateCents: 4,
      billedAmountCents: 5,
      currency: 'USD',
      deepLink: 'cguard://incidents/1',
    };
    const id = await commLog(db, input);
    assert.ok(id, 'log() should return the created row id');
    const written = db.communicationLog.calls.create[0];
    for (const [k, v] of Object.entries(input)) {
      assert.deepStrictEqual(written[k], v, `log field "${k}" was dropped or altered`);
    }
    assert.ok(written.deliveredAt instanceof Date, 'delivered status must stamp deliveredAt');
  });

  it('updateStatusByProviderMessageId advances the RIGHT row and stamps the status time', async () => {
    const db = buildDb({
      commLogs: [
        { id: 'cl-1', providerMessageId: 'wamid-1', status: 'sent', tenantId: TENANT },
        { id: 'cl-2', providerMessageId: 'wamid-2', status: 'sent', tenantId: TENANT },
      ],
    });
    const ok = await updateStatusByProviderMessageId(db, 'wamid-2', 'failed' as any);
    assert.strictEqual(ok, true);
    const target = db.communicationLog.rows.find((r: any) => r.id === 'cl-2');
    const other = db.communicationLog.rows.find((r: any) => r.id === 'cl-1');
    assert.strictEqual(target.status, 'failed');
    assert.ok(target.__updateCalls[0].failedAt instanceof Date);
    assert.strictEqual(other.__updateCalls.length, 0, 'only the matching row may change');
  });

  it('updateStatusByProviderMessageId returns false for an unknown id (no write)', async () => {
    const db = buildDb();
    assert.strictEqual(await updateStatusByProviderMessageId(db, 'nope', 'read' as any), false);
  });
});
