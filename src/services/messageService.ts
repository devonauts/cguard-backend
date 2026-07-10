/**
 * Internal messaging service (CRM ↔ worker, CRM → client-ready).
 *
 * Tenant isolation is MANUAL and mandatory: every query filters tenantId and
 * every row carries it. The DB is the source of truth; push is a best-effort
 * nudge (never rolls back a send). Read/delivery state is per-recipient
 * (messageReceipt), and sends are idempotent via clientMsgId.
 *
 * The CONTROLLER is the trust boundary for senderType ('staff' from CRM, 'guard'
 * from the worker endpoints, 'client' from the customer endpoints) — never the
 * request body.
 */

import { encryptBody, decryptBody } from '../lib/messageCrypto';

type SenderType = 'staff' | 'guard' | 'client';
type RecipientType = 'guard' | 'client';

/** Hide a conversation for one user (WhatsApp-style per-user delete). Upserts
 *  the hiddenAt so re-deleting just refreshes the clear point. */
export async function hideConversationForUser(db: any, tenantId: string, userId: string, conversationId: string): Promise<void> {
  const now = new Date();
  const existing = await db.messageHidden.findOne({ where: { tenantId, userId, conversationId } });
  if (existing) { existing.hiddenAt = now; await existing.save(); }
  else await db.messageHidden.create({ tenantId, userId, conversationId, hiddenAt: now });
}

/** Map conversationId → hiddenAt for a viewer (their per-user delete points). */
async function hiddenMap(db: any, tenantId: string, userId?: string): Promise<Map<string, Date>> {
  const m = new Map<string, Date>();
  if (!userId) return m;
  try {
    const rows = await db.messageHidden.findAll({ where: { tenantId, userId }, attributes: ['conversationId', 'hiddenAt'], raw: true });
    for (const r of rows) m.set(String(r.conversationId), new Date(r.hiddenAt));
  } catch { /* table may not exist yet */ }
  return m;
}

const preview = (body: string) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** A short label for a message that carries only attachments (no text). */
const attachmentLabel = (atts: Array<{ type?: string }>): string => {
  if (!atts || !atts.length) return '';
  if (atts.some((a) => a?.type === 'audio')) return '🎤 Audio';
  if (atts.some((a) => a?.type === 'video')) return '🎥 Video';
  return '📷 Imagen';
};

/** Resolve a recipient (guard securityGuardId / client clientAccountId) to the
 *  canonical user.id + denormalized FKs + a display name. */
export async function resolveRecipient(
  db: any,
  tenantId: string,
  recipientType: RecipientType,
  recipientId: string,
): Promise<{ recipientUserId: string | null; recipientSecurityGuardId: string | null; recipientClientAccountId: string | null; name: string } | null> {
  if (recipientType === 'guard') {
    const { Op } = db.Sequelize;
    // recipientId may be a securityGuard.id OR the guard's user id (guardId) —
    // accept either, since the autocomplete returns user ids.
    const sg = await db.securityGuard.findOne({
      where: { tenantId, deletedAt: null, [Op.or]: [{ id: recipientId }, { guardId: recipientId }] },
      attributes: ['id', 'guardId', 'fullName'],
    });
    if (!sg) return null;
    return { recipientUserId: sg.guardId || null, recipientSecurityGuardId: sg.id, recipientClientAccountId: null, name: sg.fullName || 'Guardia' };
  }
  const ca = await db.clientAccount.findOne({ where: { id: recipientId, tenantId, deletedAt: null }, attributes: ['id', 'userId', 'name', 'lastName', 'commercialName'] });
  if (!ca) return null;
  const nm = ca.commercialName || [ca.name, ca.lastName].filter(Boolean).join(' ') || 'Cliente';
  return { recipientUserId: ca.userId || null, recipientSecurityGuardId: null, recipientClientAccountId: ca.id, name: nm };
}

/** Find the existing direct conversation for a recipient, or create one. */
export async function getOrCreateConversation(
  db: any,
  tenantId: string,
  adminUserId: string,
  input: { recipientType: RecipientType; recipientId: string; subject?: string | null; isOneWay?: boolean },
): Promise<any> {
  const resolved = await resolveRecipient(db, tenantId, input.recipientType, input.recipientId);
  if (!resolved) throw Object.assign(new Error('Destinatario no válido para este inquilino'), { code: 400 });

  const where: any = { tenantId, recipientType: input.recipientType, archived: false, deletedAt: null };
  if (input.recipientType === 'guard') where.recipientSecurityGuardId = resolved.recipientSecurityGuardId;
  else where.recipientClientAccountId = resolved.recipientClientAccountId;

  let convo = await db.messageConversation.findOne({ where });
  if (!convo) {
    convo = await db.messageConversation.create({
      tenantId,
      kind: 'direct',
      recipientType: input.recipientType,
      recipientUserId: resolved.recipientUserId,
      recipientSecurityGuardId: resolved.recipientSecurityGuardId,
      recipientClientAccountId: resolved.recipientClientAccountId,
      subject: input.subject || null,
      isOneWay: !!input.isOneWay,
      createdById: adminUserId,
      updatedById: adminUserId,
    });
  }
  return convo;
}

/**
 * Persist a message + its recipient receipt, update the conversation denorm,
 * then fire a best-effort push. Idempotent on clientMsgId.
 */
export async function sendMessage(
  db: any,
  tenantId: string,
  opts: {
    conversation: any;
    senderUserId: string;
    senderType: SenderType;
    body: string;
    clientMsgId?: string | null;
    attachments?: Array<{ url?: string; type?: string; name?: string; sizeInBytes?: number }>;
  },
): Promise<any> {
  const { Op } = db.Sequelize;
  const { conversation, senderUserId, senderType, body } = opts;
  const clientMsgId = opts.clientMsgId || null;

  // Sanitize attachments: keep only well-formed image/video/audio entries (max 10).
  const attachments = (Array.isArray(opts.attachments) ? opts.attachments : [])
    .filter((a) => a && typeof a.url === 'string' && a.url.trim())
    .slice(0, 10)
    .map((a) => ({
      url: String(a.url),
      type: (a.type === 'video' || a.type === 'audio') ? a.type : 'image',
      name: a.name ? String(a.name).slice(0, 200) : null,
      sizeInBytes: typeof a.sizeInBytes === 'number' ? a.sizeInBytes : null,
    }));

  // A message must carry text OR at least one attachment.
  if ((!body || !String(body).trim()) && attachments.length === 0) {
    throw Object.assign(new Error('El mensaje no puede estar vacío'), { code: 400 });
  }

  // Guards/clients cannot reply to a one-way (broadcast) conversation.
  if (conversation.isOneWay && senderType !== 'staff') {
    const e: any = new Error('Esta conversación es solo de lectura'); e.code = 400; throw e;
  }

  // Idempotency: a retry with the same clientMsgId returns the existing message.
  if (clientMsgId) {
    const existing = await db.message.findOne({ where: { tenantId, senderUserId, clientMsgId, deletedAt: null } });
    if (existing) { (existing as any).body = decryptBody(existing.body); return existing; }
  }

  // Resolve who should receive this message (and a receipt). For a direct thread
  // that's the OTHER participant (admin→recipient, or guard/client→the owning
  // admin). For a group, every active participant except the sender — after
  // re-deriving auto membership so newly-assigned guards are included.
  const recipients = await getConversationRecipients(db, tenantId, conversation, senderUserId, senderType);

  const transaction = await db.sequelize.transaction();
  let message: any;
  try {
    message = await db.message.create(
      { tenantId, conversationId: conversation.id, senderUserId, senderType, body: encryptBody(String(body || '')), attachments: attachments.length ? attachments : null, clientMsgId, createdById: senderUserId, updatedById: senderUserId },
      { transaction },
    );
    // ONE INSERT for the whole receipt fan-out — a large group send must not
    // hold the transaction (and its pool connection) open for N sequential
    // round-trips. (Per-row fallback only serves test doubles w/o bulkCreate.)
    const receiptRows = recipients.map((r) => (
      { tenantId, messageId: message.id, conversationId: conversation.id, recipientUserId: r.userId, deliveryStatus: 'pending' }
    ));
    if (receiptRows.length) {
      if (typeof db.messageReceipt.bulkCreate === 'function') {
        await db.messageReceipt.bulkCreate(receiptRows, { transaction });
      } else {
        for (const row of receiptRows) await db.messageReceipt.create(row, { transaction });
      }
    }
    await conversation.update(
      { lastMessageAt: message.createdAt, lastMessagePreview: encryptBody(preview(body) || attachmentLabel(attachments)), updatedById: senderUserId },
      { transaction },
    );
    await transaction.commit();
  } catch (e: any) {
    await transaction.rollback();
    // Lost the idempotency race → return the winner.
    if (clientMsgId && /unique|duplicate/i.test(e?.message || '')) {
      const existing = await db.message.findOne({ where: { tenantId, senderUserId, clientMsgId } });
      if (existing) { (existing as any).body = decryptBody(existing.body); return existing; }
    }
    throw e;
  }

  // Best-effort notification — never affects the committed send.
  notifyRecipients(db, tenantId, conversation, message, recipients).catch(() => {});

  // Return PLAINTEXT to the sender so their just-sent message renders immediately
  // (at-rest stays encrypted; other viewers decrypt on read via listMessages).
  (message as any).body = String(body || '');
  (conversation as any).lastMessagePreview = preview(body) || attachmentLabel(attachments);
  return message;
}

/** A message recipient: the user.id + how to reach them (staff → CRM event,
 *  guard/client → device push). */
type Recipient = { userId: string; type: 'staff' | 'guard' | 'client' };

/** Resolve the recipients (each gets a receipt + notification) for a send. */
async function getConversationRecipients(
  db: any,
  tenantId: string,
  conversation: any,
  senderUserId: string,
  senderType: SenderType,
): Promise<Recipient[]> {
  if (conversation.kind === 'group') {
    // Keep auto membership fresh so a newly-assigned guard receives this message.
    // Re-deriving membership is O(members) sequential DB work, so skip it when
    // the last sync (groupSyncedAt, stamped by syncGroupMembership) is fresh.
    // Explicit membership operations (group create/update, the manual sync
    // endpoint) still call syncGroupMembership directly and are never gated.
    if (conversation.anchorId) {
      const GROUP_SYNC_TTL_MS = 5 * 60 * 1000;
      const syncedAt = conversation.groupSyncedAt ? new Date(conversation.groupSyncedAt).getTime() : 0;
      if (!syncedAt || Date.now() - syncedAt >= GROUP_SYNC_TTL_MS) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { syncGroupMembership } = require('./groupMembershipService');
          await syncGroupMembership(db, conversation.id, tenantId);
        } catch (e: any) { console.warn('[message] group resync failed:', e?.message || e); }
      }
    }
    const parts = await db.messageConversationParticipant.findAll({
      where: { tenantId, conversationId: conversation.id, deletedAt: null },
      attributes: ['userId', 'participantType'],
    });
    const seen = new Set<string>();
    const out: Recipient[] = [];
    for (const p of parts) {
      const uid = String(p.userId);
      if (!uid || uid === senderUserId || seen.has(uid)) continue;
      seen.add(uid);
      out.push({ userId: uid, type: p.participantType === 'staff' ? 'staff' : 'guard' });
    }
    return out;
  }
  // Direct thread.
  const single = senderType === 'staff' ? conversation.recipientUserId : conversation.createdById;
  if (!single) return [];
  const type: Recipient['type'] = senderType === 'staff'
    ? (conversation.recipientType === 'client' ? 'client' : 'guard')
    : 'staff';
  return [{ userId: String(single), type }];
}

/** Notify each recipient: a CRM platform event for staff (bell + toast + chime),
 *  a device push for guards/clients. Best-effort; never throws. For a group this
 *  fans out one notification per participant (minus the sender). */
async function notifyRecipients(db: any, tenantId: string, conversation: any, message: any, recipients: Recipient[]) {
  try {
    if (!recipients || !recipients.length) return;

    let senderName = 'Mensaje';
    try {
      const u = await db.user.findByPk(message.senderUserId, { attributes: ['fullName', 'firstName'] });
      senderName = (u && (u.fullName || u.firstName)) || 'Mensaje';
    } catch { /* ignore */ }
    const atts = Array.isArray(message.attachments) ? message.attachments : [];
    // First image attachment → rich-notification image. FCM renders it natively;
    // direct-APNs sets mutable-content so the iOS service extension attaches it,
    // and both apps persist it into the in-app feed's image/imageUrl field.
    const firstImage = atts.find(
      (a: any) => a && typeof a.url === 'string' && a.url && (a.type === 'image' || !a.type),
    );
    const imageUrl = firstImage && /^https?:\/\//i.test(firstImage.url) ? String(firstImage.url) : undefined;
    const body = decryptBody(String(message.body || '')).slice(0, 150) || attachmentLabel(atts);
    // For groups, prefix the sender so the recipient knows who wrote in the group.
    const isGroup = conversation.kind === 'group';
    const groupName = isGroup ? (conversation.subject || 'Grupo') : '';
    const title = isGroup ? groupName : senderName;
    const displayBody = isGroup ? `${senderName}: ${body}`.slice(0, 180) : body;
    const payload = {
      conversationId: String(conversation.id),
      messageId: String(message.id),
      senderId: String(message.senderUserId),
      senderName,
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { storePlatformEvent } = require('../lib/platformEventStore');
    const { pushToUser, pushToClientAccounts } = require('./pushService');

    const pushPayload = { title, body: displayBody, data: { type: 'message.new', ...payload }, ...(imageUrl ? { image: imageUrl } : {}) };

    for (const r of recipients) {
      try {
        if (r.type === 'staff') {
          // Staff live in the CRM → bell + toast + chime via a targeted platform event.
          await storePlatformEvent(db, {
            tenantId,
            eventType: 'message.new',
            title,
            body: displayBody,
            recipientUserId: r.userId,
            sourceEntityType: 'conversation',
            sourceEntityId: String(conversation.id),
            payload,
          });
          // Also push to the staffer's device(s) so supervisors in the field are
          // alerted even when they don't have the CRM open. No-op if no token.
          await pushToUser(db, tenantId, r.userId, pushPayload);
        } else if (r.type === 'client') {
          // The client app registers its FCM token by clientAccountId (it never
          // reliably sets userId), so a plain pushToUser resolves zero tokens.
          // Resolve by clientAccountId OR userId so customers actually get the push.
          const caIds = conversation.recipientClientAccountId
            ? [String(conversation.recipientClientAccountId)]
            : [];
          await pushToClientAccounts(db, tenantId, caIds, r.userId ? [r.userId] : [], pushPayload);

          // Realtime (Mi Seguridad): push the new message live to the customer's
          // socket room so the app no longer needs to poll. Best-effort — a socket
          // emit must never affect the committed send. Payload: { conversationId, message }.
          if (conversation.recipientClientAccountId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { emitToClientAccount } = require('../lib/realtime');
              emitToClientAccount(
                tenantId,
                String(conversation.recipientClientAccountId),
                'message:new',
                {
                  conversationId: String(conversation.id),
                  message: typeof message.get === 'function' ? message.get({ plain: true }) : message,
                },
              );
            } catch (e: any) {
              console.warn('[message] realtime client emit failed:', e?.message || e);
            }
          }
        } else {
          // Guard → device push.
          await pushToUser(db, tenantId, r.userId, pushPayload);
        }
      } catch (e: any) {
        console.warn('[message] notify recipient failed:', e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[message] notify failed:', e?.message || e);
  }
}

/** Create a group conversation (kind='group') anchored to a post site / station,
 *  with the creating staff user as an admin participant. */
export async function createGroupConversation(
  db: any,
  tenantId: string,
  adminUserId: string,
  input: { name: string; anchorType?: string | null; anchorId?: string | null; isOneWay?: boolean; avatarUrl?: string | null },
): Promise<any> {
  const convo = await db.messageConversation.create({
    tenantId,
    kind: 'group',
    recipientType: 'guard', // groups are guard-membership; satisfies the NOT NULL/isIn
    recipientUserId: null,
    subject: input.name ? String(input.name).slice(0, 200) : 'Grupo',
    isOneWay: !!input.isOneWay,
    anchorType: input.anchorType || null,
    anchorId: input.anchorId || null,
    avatarUrl: input.avatarUrl || null,
    createdById: adminUserId,
    updatedById: adminUserId,
  });
  const { upsertParticipant } = require('./groupMembershipService');
  await upsertParticipant(db, tenantId, convo.id, adminUserId, { participantType: 'staff', role: 'admin', source: 'manual', actorId: adminUserId });
  return convo;
}

/** Unread receipt counts for a viewer, grouped by conversation. */
async function unreadByConversation(db: any, tenantId: string, viewerUserId: string): Promise<Map<string, number>> {
  const { Op, fn, col } = db.Sequelize;
  const rows = await db.messageReceipt.findAll({
    where: { tenantId, recipientUserId: viewerUserId, deliveryStatus: { [Op.ne]: 'read' }, deletedAt: null },
    attributes: ['conversationId', [fn('COUNT', col('id')), 'n']],
    group: ['conversationId'],
    raw: true,
  });
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.conversationId), Number(r.n) || 0);
  return m;
}

/** Inbox listing. asAdmin → all tenant conversations; else only mine (as recipient). */
export async function listConversations(
  db: any,
  tenantId: string,
  viewerUserId: string,
  opts: { asAdmin?: boolean; limit?: number; cursor?: string | null; recipientType?: RecipientType | null; q?: string | null } = {},
): Promise<{ rows: any[]; nextCursor: string | null }> {
  const { Op } = db.Sequelize;
  const limit = Math.min(opts.limit || 25, 100);
  const where: any = { tenantId, archived: false, deletedAt: null };
  // Non-admin viewers see direct threads where they are the recipient PLUS any
  // group they participate in.
  if (!opts.asAdmin) {
    const partRows = await db.messageConversationParticipant.findAll({
      where: { tenantId, userId: viewerUserId, deletedAt: null }, attributes: ['conversationId'], raw: true,
    });
    const partIds = (partRows || []).map((r: any) => String(r.conversationId));
    // A user's own inbox = direct threads where they're the recipient OR the
    // creator, plus any group they participate in. (createdById is what lets a
    // supervisor see the threads THEY started with a guard/client.)
    where[Op.or] = [
      { recipientUserId: viewerUserId },
      { createdById: viewerUserId },
      ...(partIds.length ? [{ id: { [Op.in]: partIds } }] : []),
    ];
  }
  if (opts.recipientType) where.recipientType = opts.recipientType;
  if (opts.cursor) where.lastMessageAt = { [Op.lt]: new Date(opts.cursor) };
  if (opts.q) where.subject = { [Op.like]: `%${opts.q}%` };

  const convos = await db.messageConversation.findAll({
    where,
    order: [['lastMessageAt', 'DESC'], ['createdAt', 'DESC']],
    limit: limit + 1,
    include: [
      { model: db.securityGuard, as: 'recipientGuard', attributes: ['id', 'fullName'], required: false },
      { model: db.clientAccount, as: 'recipientClient', attributes: ['id', 'name', 'lastName', 'commercialName'], required: false },
    ],
  });

  const unread = await unreadByConversation(db, tenantId, viewerUserId);
  // Per-user delete: drop conversations this viewer hid, unless a newer message
  // arrived after they hid it (WhatsApp brings the chat back on a new message).
  const hidden = await hiddenMap(db, tenantId, viewerUserId);
  const filtered = hidden.size
    ? convos.filter((c: any) => {
        const h = hidden.get(String(c.id));
        return !h || new Date(c.lastMessageAt || c.createdAt) > h;
      })
    : convos;
  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;

  // Member counts for any group conversations on this page (one grouped query).
  const groupIds = page.filter((c: any) => c.kind === 'group').map((c: any) => String(c.id));
  const memberCounts = new Map<string, number>();
  if (groupIds.length) {
    const { fn, col } = db.Sequelize;
    const counts = await db.messageConversationParticipant.findAll({
      where: { tenantId, conversationId: { [Op.in]: groupIds }, deletedAt: null },
      attributes: ['conversationId', [fn('COUNT', col('id')), 'n']],
      group: ['conversationId'], raw: true,
    });
    for (const r of counts) memberCounts.set(String(r.conversationId), Number(r.n) || 0);
  }

  const rows = page.map((c: any) => {
    const p = c.get({ plain: true });
    const isGroup = p.kind === 'group';
    const name = isGroup
      ? (p.subject || 'Grupo')
      : (c.recipientGuard?.fullName
        || c.recipientClient?.commercialName
        || [c.recipientClient?.name, c.recipientClient?.lastName].filter(Boolean).join(' ')
        || (p.recipientType === 'guard' ? 'Guardia' : 'Cliente'));
    return {
      id: p.id, kind: p.kind, isGroup, recipientType: p.recipientType, recipientUserId: p.recipientUserId,
      recipientName: name, subject: p.subject, isOneWay: p.isOneWay,
      avatarUrl: p.avatarUrl || null,
      memberCount: isGroup ? (memberCounts.get(String(p.id)) || 0) : null,
      lastMessageAt: p.lastMessageAt, lastMessagePreview: decryptBody(p.lastMessagePreview),
      unreadCount: unread.get(String(p.id)) || 0,
    };
  });
  const nextCursor = hasMore && page.length ? new Date(page[page.length - 1].lastMessageAt || page[page.length - 1].createdAt).toISOString() : null;
  return { rows, nextCursor };
}

/** Load a conversation, enforcing tenant + (for non-admin) participant ownership. */
export async function getConversation(db: any, tenantId: string, conversationId: string, viewerUserId?: string, asAdmin = false): Promise<any | null> {
  const convo = await db.messageConversation.findOne({
    where: { id: conversationId, tenantId, deletedAt: null },
    include: [
      { model: db.securityGuard, as: 'recipientGuard', attributes: ['id', 'fullName'], required: false },
      { model: db.clientAccount, as: 'recipientClient', attributes: ['id', 'name', 'lastName', 'commercialName'], required: false },
    ],
  });
  if (!convo) return null;
  if (!asAdmin && viewerUserId) {
    let ok = convo.recipientUserId === viewerUserId || convo.createdById === viewerUserId;
    if (!ok && convo.kind === 'group') {
      const part = await db.messageConversationParticipant.findOne({
        where: { tenantId, conversationId, userId: viewerUserId, deletedAt: null }, attributes: ['id'],
      });
      ok = !!part;
    }
    if (!ok) return null; // not a participant
  }
  return convo;
}

/** Keyset-paginated thread (newest first). */
export async function listMessages(
  db: any,
  tenantId: string,
  conversationId: string,
  opts: { limit?: number; before?: string | null; viewerUserId?: string } = {},
): Promise<{ rows: any[]; nextCursor: string | null }> {
  const { Op } = db.Sequelize;
  const limit = Math.min(opts.limit || 30, 100);
  const where: any = { tenantId, conversationId, deletedAt: null };
  if (opts.before) where.createdAt = { [Op.lt]: new Date(opts.before) };
  // Per-user delete cleared this viewer's history — only show messages after it.
  if (opts.viewerUserId) {
    try {
      const h = await db.messageHidden.findOne({ where: { tenantId, userId: opts.viewerUserId, conversationId }, attributes: ['hiddenAt'], raw: true });
      if (h?.hiddenAt) where.createdAt = { ...(where.createdAt || {}), [Op.gt]: new Date(h.hiddenAt) };
    } catch { /* table may not exist yet */ }
  }

  const rows = await db.message.findAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: limit + 1,
    include: [
      { model: db.user, as: 'sender', attributes: ['id', 'fullName', 'firstName'], required: false },
      { model: db.messageReceipt, as: 'receipts', attributes: ['recipientUserId', 'deliveryStatus', 'deliveredAt', 'readAt'], required: false },
    ],
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const mapped = page.map((m: any) => {
    const p = m.get({ plain: true });
    return {
      id: p.id, senderUserId: p.senderUserId, senderType: p.senderType,
      senderName: m.sender?.fullName || m.sender?.firstName || (p.senderType === 'staff' ? 'Operador' : p.senderType === 'guard' ? 'Guardia' : 'Cliente'),
      body: decryptBody(p.body), attachments: p.attachments || null, createdAt: p.createdAt,
      receipt: (p.receipts && p.receipts[0]) ? { deliveryStatus: p.receipts[0].deliveryStatus, deliveredAt: p.receipts[0].deliveredAt, readAt: p.receipts[0].readAt } : null,
    };
  });
  const nextCursor = hasMore && page.length ? new Date(page[page.length - 1].createdAt).toISOString() : null;
  return { rows: mapped, nextCursor };
}

/** Mark all of the viewer's inbound receipts in a conversation as read. */
export async function markRead(db: any, tenantId: string, conversationId: string, viewerUserId: string): Promise<number> {
  const { Op } = db.Sequelize;
  const [count] = await db.messageReceipt.update(
    { deliveryStatus: 'read', readAt: new Date(), deliveredAt: db.Sequelize.literal('COALESCE(deliveredAt, NOW())') },
    { where: { tenantId, conversationId, recipientUserId: viewerUserId, deliveryStatus: { [Op.ne]: 'read' }, deletedAt: null } },
  );
  return count || 0;
}

/** Total unread for a viewer (badge). */
export async function countUnread(db: any, tenantId: string, viewerUserId: string): Promise<number> {
  const { Op } = db.Sequelize;
  return db.messageReceipt.count({ where: { tenantId, recipientUserId: viewerUserId, deliveryStatus: { [Op.ne]: 'read' }, deletedAt: null } });
}
