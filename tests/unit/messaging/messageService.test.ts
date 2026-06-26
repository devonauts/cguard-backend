/**
 * Unit tests — internal messaging service (CRM ↔ worker ↔ client).
 *
 * Exercises the REAL messageService functions end-to-end against an in-memory
 * fake `db` (no MySQL, no network). The only externals stubbed with sinon are
 * the best-effort notification fan-out (pushService + platformEventStore), which
 * messageService.require()s — so receipt creation, conversation denorm, the
 * idempotency guard, one-way enforcement, recipient resolution and the inbox
 * scope filter are all genuinely under test.
 *
 * Coverage:
 *   resolveRecipient        — guard by securityGuard.id OR guardId; client; null
 *   getOrCreateConversation — reuse existing direct thread / create / invalid recipient
 *   sendMessage             — empty rejection, one-way block (non-staff), idempotency,
 *                             receipt-per-recipient, conversation denorm, notify fan-out,
 *                             direct recipient resolution (staff→recipient, guard→owner),
 *                             attachment-only message + attachment label preview
 *   listConversations       — asAdmin (all) vs non-admin (mine + group), recipientType
 *                             filter (Operativos/Clientes split), unread counts, paging
 *   getConversation         — participant ACL (recipient/creator/group member/denied)
 *   markRead / countUnread  — receipt status transitions + badge
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json npx mocha \
 *     -r ts-node/register 'tests/unit/messaging/messageService.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

/** Drain pending microtasks + timers so the fire-and-forget notify settles. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

import {
  resolveRecipient,
  getOrCreateConversation,
  sendMessage,
  listConversations,
  getConversation,
  listMessages,
  markRead,
  countUnread,
} from '../../../src/services/messageService';

// The modules messageService.notifyRecipients() require()s at call-time. We stub
// their functions so the best-effort push fan-out is observable + inert.
import * as pushService from '../../../src/services/pushService';
import * as platformEventStore from '../../../src/lib/platformEventStore';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ───────────────────────────── In-memory fake DB ─────────────────────────────
//
// A tiny Sequelize-shaped stub. Each row supports get({plain})/update/destroy.
// Tables live in plain arrays so we can assert on persisted rows directly. The
// query helpers implement only the WHERE/Op shapes messageService actually uses.

const Op = {
  or: Symbol('or'),
  ne: Symbol('ne'),
  lt: Symbol('lt'),
  in: Symbol('in'),
  like: Symbol('like'),
};

// Association aliases that get({plain}) must surface (real Sequelize includes
// them in the plain object). messageService reads m.get({plain:true}).receipts.
const ASSOC_KEYS = ['recipientGuard', 'recipientClient', 'sender', 'receipts'];

function makeRow(data: any) {
  const row: any = {
    ...data,
    get(opts?: any) {
      // Return a plain copy so callers can't mutate the stored row by reference,
      // but fold in any eager-loaded associations attached to the row instance.
      const plain: any = { ...data };
      for (const k of ASSOC_KEYS) if (row[k] !== undefined) plain[k] = row[k];
      return plain;
    },
    async update(patch: any) {
      Object.assign(data, patch);
      Object.assign(row, patch);
      return row;
    },
    async destroy() {
      data.deletedAt = new Date();
      row.deletedAt = data.deletedAt;
      return row;
    },
  };
  return row;
}

/** Does a stored value satisfy a (possibly Op-wrapped) condition? */
function matchValue(actual: any, cond: any): boolean {
  // `deletedAt: null` (paranoid filter) must also match rows that simply never
  // had the column set (created rows leave it undefined).
  if (cond === null) return actual === null || actual === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if (Op.ne in cond) return actual !== cond[Op.ne];
    if (Op.lt in cond) return new Date(actual).getTime() < new Date(cond[Op.lt]).getTime();
    if (Op.in in cond) return (cond[Op.in] as any[]).map(String).includes(String(actual));
    if (Op.like in cond) {
      const pat = String(cond[Op.like]).replace(/%/g, '');
      return String(actual ?? '').includes(pat);
    }
  }
  return actual === cond;
}

/** Match a row against a Sequelize-style where (top-level AND, with Op.or). */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    if (!matchValue(row[key], where[key])) return false;
  }
  if (where[Op.or]) {
    const ors: any[] = where[Op.or];
    if (!ors.some((sub) => matchWhere(row, sub))) return false;
  }
  return true;
}

interface Tables {
  securityGuard: any[];
  clientAccount: any[];
  messageConversation: any[];
  message: any[];
  messageReceipt: any[];
  messageConversationParticipant: any[];
  user: any[];
}

function buildDb(seed: Partial<Tables> = {}): any {
  const t: Tables = {
    securityGuard: (seed.securityGuard || []).map(makeRow),
    clientAccount: (seed.clientAccount || []).map(makeRow),
    messageConversation: (seed.messageConversation || []).map(makeRow),
    message: (seed.message || []).map(makeRow),
    messageReceipt: (seed.messageReceipt || []).map(makeRow),
    messageConversationParticipant: (seed.messageConversationParticipant || []).map(makeRow),
    user: (seed.user || []).map(makeRow),
  };

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  // Sequelize stub: Op + fn/col/literal (used by markRead + grouped unread).
  const Sequelize = {
    Op,
    fn: (..._args: any[]) => ({ __fn: true }),
    col: (c: string) => ({ __col: c }),
    literal: (s: string) => ({ __literal: s }),
  };

  /** Apply include-as aliases that listConversations / listMessages rely on. */
  function applyIncludes(row: any, include: any[] | undefined) {
    if (!include) return row;
    for (const inc of include) {
      if (inc.as === 'recipientGuard') {
        row.recipientGuard = t.securityGuard.find((g) => g.id === row.recipientSecurityGuardId && !g.deletedAt) || null;
      } else if (inc.as === 'recipientClient') {
        row.recipientClient = t.clientAccount.find((c) => c.id === row.recipientClientAccountId && !c.deletedAt) || null;
      } else if (inc.as === 'sender') {
        row.sender = t.user.find((u) => u.id === row.senderUserId) || null;
      } else if (inc.as === 'receipts') {
        row.receipts = t.messageReceipt.filter((rc) => rc.messageId === row.id && !rc.deletedAt);
      }
    }
    return row;
  }

  function model(table: keyof Tables, prefix: string) {
    return {
      async findOne({ where, include }: any = {}) {
        const found = t[table].find((r) => matchWhere(r, where));
        return found ? applyIncludes(found, include) : null;
      },
      async findAll({ where, include, order, limit, attributes, group, raw }: any = {}) {
        let rows = t[table].filter((r) => matchWhere(r, where));
        // Grouped COUNT (unreadByConversation / member counts / group counts).
        if (group) {
          const key = group[0];
          const buckets = new Map<string, number>();
          for (const r of rows) buckets.set(String(r[key]), (buckets.get(String(r[key])) || 0) + 1);
          return Array.from(buckets.entries()).map(([k, n]) => ({ [key]: k, n }));
        }
        if (order && order.length) {
          const [col, dir] = order[0];
          rows = [...rows].sort((a, b) => {
            const av = new Date(a[col] || 0).getTime();
            const bv = new Date(b[col] || 0).getTime();
            return dir === 'DESC' ? bv - av : av - bv;
          });
        }
        if (limit != null) rows = rows.slice(0, limit);
        rows = rows.map((r) => applyIncludes(r, include));
        if (raw) return rows.map((r) => ({ ...r }));
        return rows;
      },
      async create(data: any, _opts?: any) {
        const row = makeRow({ id: nextId(prefix), createdAt: new Date(), ...data });
        t[table].push(row);
        return row;
      },
      async count({ where }: any = {}) {
        return t[table].filter((r) => matchWhere(r, where)).length;
      },
      async update(patch: any, { where }: any = {}) {
        const rows = t[table].filter((r) => matchWhere(r, where));
        for (const r of rows) {
          for (const k of Object.keys(patch)) {
            const v = patch[k];
            r[k] = v && v.__literal ? new Date() : v; // COALESCE(deliveredAt, NOW()) → a date
          }
        }
        return [rows.length];
      },
      async destroy({ where }: any = {}) {
        const rows = t[table].filter((r) => matchWhere(r, where));
        for (const r of rows) r.deletedAt = new Date();
        return rows.length;
      },
    };
  }

  return {
    Sequelize,
    securityGuard: model('securityGuard', 'sg'),
    clientAccount: model('clientAccount', 'ca'),
    messageConversation: model('messageConversation', 'conv'),
    message: model('message', 'msg'),
    messageReceipt: model('messageReceipt', 'rcpt'),
    messageConversationParticipant: model('messageConversationParticipant', 'part'),
    user: { ...model('user', 'usr'), async findByPk(id: string) { return t.user.find((u) => u.id === id) || null; } },
    sequelize: {
      async transaction() {
        return { async commit() {}, async rollback() {} };
      },
    },
    _tables: t,
  };
}

// ─────────────────────────────── Test suites ─────────────────────────────────

describe('messaging — notify fan-out is stubbed (no real push/event)', () => {
  let pushUser: sinon.SinonStub;
  let pushClients: sinon.SinonStub;
  let storeEvent: sinon.SinonStub;

  beforeEach(() => {
    pushUser = sinon.stub(pushService, 'pushToUser').resolves({ sent: 0 } as any);
    pushClients = sinon.stub(pushService, 'pushToClientAccounts').resolves({ sent: 0 } as any);
    storeEvent = sinon.stub(platformEventStore, 'storePlatformEvent').resolves('evt-1' as any);
  });
  afterEach(() => sinon.restore());

  // ── resolveRecipient ──────────────────────────────────────────────────────
  describe('resolveRecipient', () => {
    it('resolves a guard by securityGuard.id', async () => {
      const db = buildDb({ securityGuard: [{ id: 'sg-1', guardId: 'u-guard', fullName: 'Juan Pérez', tenantId: TENANT_A, deletedAt: null }] });
      const r = await resolveRecipient(db, TENANT_A, 'guard', 'sg-1');
      assert.ok(r);
      assert.strictEqual(r!.recipientUserId, 'u-guard');
      assert.strictEqual(r!.recipientSecurityGuardId, 'sg-1');
      assert.strictEqual(r!.recipientClientAccountId, null);
      assert.strictEqual(r!.name, 'Juan Pérez');
    });

    it('resolves a guard by guardId (user id from the CRM autocomplete)', async () => {
      const db = buildDb({ securityGuard: [{ id: 'sg-1', guardId: 'u-guard', fullName: 'Juan', tenantId: TENANT_A, deletedAt: null }] });
      const r = await resolveRecipient(db, TENANT_A, 'guard', 'u-guard');
      assert.ok(r);
      assert.strictEqual(r!.recipientSecurityGuardId, 'sg-1');
      assert.strictEqual(r!.recipientUserId, 'u-guard');
    });

    it('resolves a client by clientAccount.id and prefers commercialName', async () => {
      const db = buildDb({ clientAccount: [{ id: 'ca-1', userId: 'u-client', name: 'Ana', lastName: 'Díaz', commercialName: 'ACME SA', tenantId: TENANT_A, deletedAt: null }] });
      const r = await resolveRecipient(db, TENANT_A, 'client', 'ca-1');
      assert.ok(r);
      assert.strictEqual(r!.recipientClientAccountId, 'ca-1');
      assert.strictEqual(r!.recipientUserId, 'u-client');
      assert.strictEqual(r!.name, 'ACME SA');
    });

    it('returns null for a recipient in another tenant (isolation)', async () => {
      const db = buildDb({ securityGuard: [{ id: 'sg-1', guardId: 'u', fullName: 'X', tenantId: TENANT_B, deletedAt: null }] });
      const r = await resolveRecipient(db, TENANT_A, 'guard', 'sg-1');
      assert.strictEqual(r, null);
    });
  });

  // ── getOrCreateConversation ───────────────────────────────────────────────
  describe('getOrCreateConversation', () => {
    it('creates a direct guard conversation with denormalized FKs', async () => {
      const db = buildDb({ securityGuard: [{ id: 'sg-1', guardId: 'u-guard', fullName: 'Juan', tenantId: TENANT_A, deletedAt: null }] });
      const convo = await getOrCreateConversation(db, TENANT_A, 'u-admin', { recipientType: 'guard', recipientId: 'sg-1' });
      assert.strictEqual(convo.kind, 'direct');
      assert.strictEqual(convo.recipientType, 'guard');
      assert.strictEqual(convo.recipientSecurityGuardId, 'sg-1');
      assert.strictEqual(convo.recipientUserId, 'u-guard');
      assert.strictEqual(convo.createdById, 'u-admin');
      assert.strictEqual(db._tables.messageConversation.length, 1);
    });

    it('reuses the existing non-archived thread for the same recipient', async () => {
      const db = buildDb({
        securityGuard: [{ id: 'sg-1', guardId: 'u-guard', fullName: 'Juan', tenantId: TENANT_A, deletedAt: null }],
        messageConversation: [{
          id: 'conv-existing', tenantId: TENANT_A, kind: 'direct', recipientType: 'guard',
          recipientSecurityGuardId: 'sg-1', recipientUserId: 'u-guard', archived: false, deletedAt: null, createdById: 'u-admin',
        }],
      });
      const convo = await getOrCreateConversation(db, TENANT_A, 'u-admin', { recipientType: 'guard', recipientId: 'sg-1' });
      assert.strictEqual(convo.id, 'conv-existing');
      assert.strictEqual(db._tables.messageConversation.length, 1, 'must not create a duplicate thread');
    });

    it('throws a 400 for an unresolvable recipient', async () => {
      const db = buildDb();
      await assert.rejects(
        () => getOrCreateConversation(db, TENANT_A, 'u-admin', { recipientType: 'guard', recipientId: 'nope' }),
        (e: any) => e.code === 400,
      );
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────────
  describe('sendMessage', () => {
    function directGuardThread() {
      return buildDb({
        securityGuard: [{ id: 'sg-1', guardId: 'u-guard', fullName: 'Juan', tenantId: TENANT_A, deletedAt: null }],
        user: [{ id: 'u-admin', fullName: 'Operador' }, { id: 'u-guard', fullName: 'Juan' }],
        messageConversation: [{
          id: 'conv-1', tenantId: TENANT_A, kind: 'direct', recipientType: 'guard',
          recipientSecurityGuardId: 'sg-1', recipientUserId: 'u-guard', archived: false, deletedAt: null,
          createdById: 'u-admin', isOneWay: false,
        }],
      });
    }

    it('rejects an empty message (no body, no attachments)', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      await assert.rejects(
        () => sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: '   ' }),
        (e: any) => e.code === 400,
      );
    });

    it('staff→guard: persists message, creates ONE receipt for the recipient, updates denorm, notifies', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      const msg = await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: 'Hola Juan' });

      assert.strictEqual(db._tables.message.length, 1);
      assert.strictEqual(msg.body, 'Hola Juan');
      assert.strictEqual(msg.senderType, 'staff');

      // Recipient of a staff send is the conversation.recipientUserId (the guard).
      assert.strictEqual(db._tables.messageReceipt.length, 1);
      assert.strictEqual(db._tables.messageReceipt[0].recipientUserId, 'u-guard');
      assert.strictEqual(db._tables.messageReceipt[0].deliveryStatus, 'pending');

      // Conversation denorm advanced.
      assert.strictEqual(convo.lastMessagePreview, 'Hola Juan');
      assert.ok(convo.lastMessageAt);

      // Best-effort guard push fired once (notify is fire-and-forget → settle it).
      await flush();
      assert.ok(pushUser.calledOnce, 'guard should get a device push');
      assert.ok(pushUser.calledWith(sinon.match.any, TENANT_A, 'u-guard'));
    });

    it('guard→staff: recipient is the owning admin (conversation.createdById)', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-guard', senderType: 'guard', body: 'Reporte' });

      assert.strictEqual(db._tables.messageReceipt.length, 1);
      assert.strictEqual(db._tables.messageReceipt[0].recipientUserId, 'u-admin', 'inbound lands on the office admin');

      // Staff recipient → a CRM platform event (bell) is stored, not a client push.
      await flush();
      assert.ok(storeEvent.calledOnce, 'staff gets a CRM platform event');
      const evt = storeEvent.firstCall.args[1];
      assert.strictEqual(evt.recipientUserId, 'u-admin');
      assert.strictEqual(evt.eventType, 'message.new');
    });

    it('blocks a guard reply to a one-way (broadcast) conversation', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      await convo.update({ isOneWay: true });
      await assert.rejects(
        () => sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-guard', senderType: 'guard', body: 'no puedo' }),
        (e: any) => e.code === 400,
      );
      // Staff may still post to a one-way thread.
      const ok = await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: 'aviso' });
      assert.ok(ok.id);
    });

    it('is idempotent on clientMsgId (a retry returns the same message, no dup)', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      const a = await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: 'Hi', clientMsgId: 'cm-1' });
      const b = await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: 'Hi again', clientMsgId: 'cm-1' });
      assert.strictEqual(a.id, b.id, 'same clientMsgId → same message');
      assert.strictEqual(db._tables.message.length, 1, 'no duplicate row');
      assert.strictEqual(db._tables.messageReceipt.length, 1);
    });

    it('accepts an attachment-only message and previews it as a voice-note label', async () => {
      const db = directGuardThread();
      const convo = db._tables.messageConversation[0];
      const msg = await sendMessage(db, TENANT_A, {
        conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: '',
        attachments: [{ url: 'https://x/v.m4a', type: 'audio', name: 'nota.m4a', sizeInBytes: 1234 }],
      });
      assert.ok(Array.isArray(msg.attachments) && msg.attachments.length === 1);
      assert.strictEqual(msg.attachments[0].type, 'audio');
      assert.strictEqual(convo.lastMessagePreview, '🎤 Audio');
    });

    it('client send pushes via pushToClientAccounts (resolves by clientAccountId)', async () => {
      const db = buildDb({
        clientAccount: [{ id: 'ca-1', userId: 'u-client', commercialName: 'ACME', tenantId: TENANT_A, deletedAt: null }],
        user: [{ id: 'u-admin', fullName: 'Operador' }, { id: 'u-client', fullName: 'ACME' }],
        messageConversation: [{
          id: 'conv-c', tenantId: TENANT_A, kind: 'direct', recipientType: 'client',
          recipientClientAccountId: 'ca-1', recipientUserId: 'u-client', archived: false, deletedAt: null,
          createdById: 'u-admin', isOneWay: false,
        }],
      });
      const convo = db._tables.messageConversation[0];
      await sendMessage(db, TENANT_A, { conversation: convo, senderUserId: 'u-admin', senderType: 'staff', body: 'Hola cliente' });
      await flush();
      assert.ok(pushClients.calledOnce, 'client gets a push via pushToClientAccounts');
      // signature: (db, tenantId, [clientAccountId], [userId], payload)
      assert.deepStrictEqual(pushClients.firstCall.args[2], ['ca-1']);
    });
  });

  // ── markRead / countUnread ────────────────────────────────────────────────
  describe('markRead + countUnread', () => {
    it('marks a viewer’s pending receipts read and drops the badge', async () => {
      const db = buildDb({
        messageReceipt: [
          { id: 'r1', tenantId: TENANT_A, conversationId: 'conv-1', messageId: 'm1', recipientUserId: 'u-guard', deliveryStatus: 'pending', deletedAt: null },
          { id: 'r2', tenantId: TENANT_A, conversationId: 'conv-1', messageId: 'm2', recipientUserId: 'u-guard', deliveryStatus: 'delivered', deletedAt: null },
          { id: 'r3', tenantId: TENANT_A, conversationId: 'conv-1', messageId: 'm3', recipientUserId: 'u-other', deliveryStatus: 'pending', deletedAt: null },
        ],
      });
      assert.strictEqual(await countUnread(db, TENANT_A, 'u-guard'), 2, 'two non-read receipts before');
      const n = await markRead(db, TENANT_A, 'conv-1', 'u-guard');
      assert.strictEqual(n, 2, 'both of the viewer’s receipts flip to read');
      assert.strictEqual(await countUnread(db, TENANT_A, 'u-guard'), 0);
      // Another user’s receipt is untouched.
      assert.strictEqual(await countUnread(db, TENANT_A, 'u-other'), 1);
      assert.ok(db._tables.messageReceipt[0].readAt, 'readAt stamped');
    });

    it('countUnread is tenant-scoped', async () => {
      const db = buildDb({
        messageReceipt: [
          { id: 'r1', tenantId: TENANT_A, conversationId: 'c', recipientUserId: 'u', deliveryStatus: 'pending', deletedAt: null },
          { id: 'r2', tenantId: TENANT_B, conversationId: 'c', recipientUserId: 'u', deliveryStatus: 'pending', deletedAt: null },
        ],
      });
      assert.strictEqual(await countUnread(db, TENANT_A, 'u'), 1);
      assert.strictEqual(await countUnread(db, TENANT_B, 'u'), 1);
    });
  });

  // ── listConversations scope + filters ─────────────────────────────────────
  describe('listConversations scope + recipientType filter', () => {
    function inboxDb() {
      return buildDb({
        securityGuard: [{ id: 'sg-1', fullName: 'Juan', tenantId: TENANT_A, deletedAt: null }],
        clientAccount: [{ id: 'ca-1', commercialName: 'ACME', tenantId: TENANT_A, deletedAt: null }],
        messageConversation: [
          { id: 'conv-g', tenantId: TENANT_A, kind: 'direct', recipientType: 'guard', recipientSecurityGuardId: 'sg-1', recipientUserId: 'u-guard', archived: false, deletedAt: null, createdById: 'u-admin', lastMessageAt: new Date('2026-06-20T10:00:00Z'), lastMessagePreview: 'g' },
          { id: 'conv-c', tenantId: TENANT_A, kind: 'direct', recipientType: 'client', recipientClientAccountId: 'ca-1', recipientUserId: 'u-client', archived: false, deletedAt: null, createdById: 'u-admin', lastMessageAt: new Date('2026-06-20T11:00:00Z'), lastMessagePreview: 'c' },
          { id: 'conv-grp', tenantId: TENANT_A, kind: 'group', recipientType: 'guard', subject: 'Puesto Norte', archived: false, deletedAt: null, createdById: 'u-admin', lastMessageAt: new Date('2026-06-20T12:00:00Z'), lastMessagePreview: 'grp' },
          { id: 'conv-other-tenant', tenantId: TENANT_B, kind: 'direct', recipientType: 'guard', recipientUserId: 'u-guard', archived: false, deletedAt: null, createdById: 'u-admin', lastMessageAt: new Date() },
        ],
        messageConversationParticipant: [
          { id: 'p1', tenantId: TENANT_A, conversationId: 'conv-grp', userId: 'u-guard', participantType: 'guard', deletedAt: null },
          { id: 'p2', tenantId: TENANT_A, conversationId: 'conv-grp', userId: 'u-admin', participantType: 'staff', deletedAt: null },
        ],
        messageReceipt: [
          { id: 'r1', tenantId: TENANT_A, conversationId: 'conv-grp', recipientUserId: 'u-guard', deliveryStatus: 'pending', deletedAt: null },
        ],
      });
    }

    it('asAdmin returns ALL tenant conversations (and only this tenant)', async () => {
      const db = inboxDb();
      const { rows } = await listConversations(db, TENANT_A, 'u-admin', { asAdmin: true });
      const ids = rows.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['conv-c', 'conv-g', 'conv-grp'], 'no cross-tenant leak');
    });

    it('CRM "Clientes" filter (recipientType=client) returns only client threads', async () => {
      const db = inboxDb();
      const { rows } = await listConversations(db, TENANT_A, 'u-admin', { asAdmin: true, recipientType: 'client' });
      assert.deepStrictEqual(rows.map((r) => r.id), ['conv-c']);
      assert.strictEqual(rows[0].recipientName, 'ACME');
    });

    it('non-admin (a guard) sees only their direct thread + groups they belong to, with unread + memberCount', async () => {
      const db = inboxDb();
      const { rows } = await listConversations(db, TENANT_A, 'u-guard', { asAdmin: false });
      const ids = rows.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['conv-g', 'conv-grp'], 'guard does not see the client thread');
      const grp = rows.find((r) => r.id === 'conv-grp')!;
      assert.strictEqual(grp.isGroup, true);
      assert.strictEqual(grp.memberCount, 2);
      assert.strictEqual(grp.unreadCount, 1, 'unread receipt surfaces as a badge');
      assert.strictEqual(grp.recipientName, 'Puesto Norte');
    });
  });

  // ── getConversation ACL ───────────────────────────────────────────────────
  describe('getConversation participant ACL', () => {
    function aclDb() {
      return buildDb({
        messageConversation: [
          { id: 'conv-1', tenantId: TENANT_A, kind: 'direct', recipientType: 'guard', recipientUserId: 'u-guard', createdById: 'u-admin', deletedAt: null },
          { id: 'conv-grp', tenantId: TENANT_A, kind: 'group', recipientType: 'guard', createdById: 'u-admin', deletedAt: null },
        ],
        messageConversationParticipant: [
          { id: 'p1', tenantId: TENANT_A, conversationId: 'conv-grp', userId: 'u-member', participantType: 'guard', deletedAt: null },
        ],
      });
    }

    it('admin (asAdmin) can load any tenant thread', async () => {
      const db = aclDb();
      const c = await getConversation(db, TENANT_A, 'conv-1', undefined, true);
      assert.ok(c && c.id === 'conv-1');
    });

    it('the recipient and the creator can load a direct thread; an outsider cannot', async () => {
      const db = aclDb();
      assert.ok(await getConversation(db, TENANT_A, 'conv-1', 'u-guard', false));
      assert.ok(await getConversation(db, TENANT_A, 'conv-1', 'u-admin', false));
      assert.strictEqual(await getConversation(db, TENANT_A, 'conv-1', 'u-stranger', false), null);
    });

    it('a group member can load the group; a non-member cannot', async () => {
      const db = aclDb();
      assert.ok(await getConversation(db, TENANT_A, 'conv-grp', 'u-member', false));
      assert.strictEqual(await getConversation(db, TENANT_A, 'conv-grp', 'u-stranger', false), null);
    });
  });

  // ── listMessages shape (receipt projection for read-state) ─────────────────
  describe('listMessages shape', () => {
    it('returns newest-first rows with sender name + receipt projection', async () => {
      const db = buildDb({
        user: [{ id: 'u-admin', fullName: 'Operador' }],
        message: [
          { id: 'm1', tenantId: TENANT_A, conversationId: 'conv-1', senderUserId: 'u-admin', senderType: 'staff', body: 'uno', attachments: null, createdAt: new Date('2026-06-20T10:00:00Z'), deletedAt: null },
          { id: 'm2', tenantId: TENANT_A, conversationId: 'conv-1', senderUserId: 'u-admin', senderType: 'staff', body: 'dos', attachments: null, createdAt: new Date('2026-06-20T11:00:00Z'), deletedAt: null },
        ],
        messageReceipt: [
          { id: 'r2', tenantId: TENANT_A, conversationId: 'conv-1', messageId: 'm2', recipientUserId: 'u-guard', deliveryStatus: 'read', readAt: new Date(), deletedAt: null },
        ],
      });
      const { rows } = await listMessages(db, TENANT_A, 'conv-1');
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].body, 'dos', 'newest first');
      assert.strictEqual(rows[0].senderName, 'Operador');
      assert.strictEqual(rows[0].receipt!.deliveryStatus, 'read', 'sender sees the recipient read-state');
      assert.strictEqual(rows[1].receipt, null, 'no receipt → null');
    });
  });
});
