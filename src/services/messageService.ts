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

type SenderType = 'staff' | 'guard' | 'client';
type RecipientType = 'guard' | 'client';

const preview = (body: string) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200);

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
  if (!resolved) throw new Error('Destinatario no válido para este inquilino');

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
  },
): Promise<any> {
  const { Op } = db.Sequelize;
  const { conversation, senderUserId, senderType, body } = opts;
  const clientMsgId = opts.clientMsgId || null;
  if (!body || !String(body).trim()) throw new Error('El mensaje no puede estar vacío');

  // Guards/clients cannot reply to a one-way (broadcast) conversation.
  if (conversation.isOneWay && senderType !== 'staff') {
    const e: any = new Error('Esta conversación es solo de lectura'); e.code = 400; throw e;
  }

  // Idempotency: a retry with the same clientMsgId returns the existing message.
  if (clientMsgId) {
    const existing = await db.message.findOne({ where: { tenantId, senderUserId, clientMsgId, deletedAt: null } });
    if (existing) return existing;
  }

  // The receipt goes to the OTHER participant: admin→recipient, or
  // guard/client→the admin who owns the thread (createdById).
  const recipientUserId = senderType === 'staff' ? conversation.recipientUserId : conversation.createdById;

  const transaction = await db.sequelize.transaction();
  let message: any;
  try {
    message = await db.message.create(
      { tenantId, conversationId: conversation.id, senderUserId, senderType, body: String(body), clientMsgId, createdById: senderUserId, updatedById: senderUserId },
      { transaction },
    );
    if (recipientUserId) {
      await db.messageReceipt.create(
        { tenantId, messageId: message.id, conversationId: conversation.id, recipientUserId, deliveryStatus: 'pending' },
        { transaction },
      );
    }
    await conversation.update(
      { lastMessageAt: message.createdAt, lastMessagePreview: preview(body), updatedById: senderUserId },
      { transaction },
    );
    await transaction.commit();
  } catch (e: any) {
    await transaction.rollback();
    // Lost the idempotency race → return the winner.
    if (clientMsgId && /unique|duplicate/i.test(e?.message || '')) {
      const existing = await db.message.findOne({ where: { tenantId, senderUserId, clientMsgId } });
      if (existing) return existing;
    }
    throw e;
  }

  // Best-effort notification — never affects the committed send.
  notifyRecipient(db, tenantId, conversation, message, recipientUserId, senderType).catch(() => {});
  return message;
}

/** Notify the recipient: a CRM platform event for staff (bell + toast + chime),
 *  a device push for guards/clients. Never throws. */
async function notifyRecipient(db: any, tenantId: string, conversation: any, message: any, recipientUserId: string | null, senderType: SenderType) {
  try {
    if (!recipientUserId) return;

    let senderName = 'Mensaje';
    try {
      const u = await db.user.findByPk(message.senderUserId, { attributes: ['fullName', 'firstName'] });
      senderName = (u && (u.fullName || u.firstName)) || 'Mensaje';
    } catch { /* ignore */ }
    const body = String(message.body || '').slice(0, 150);

    // Guard/client → staff: surface it in the CRM (bell + toast + chime) via a
    // platform event targeted at the conversation owner. Admins live in the CRM,
    // so no device push.
    if (senderType !== 'staff') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { storePlatformEvent } = require('../lib/platformEventStore');
        await storePlatformEvent(db, {
          tenantId,
          eventType: 'message.new',
          title: senderName,
          body,
          recipientUserId,
          sourceEntityType: 'conversation',
          sourceEntityId: String(conversation.id),
          payload: {
            conversationId: String(conversation.id),
            messageId: String(message.id),
            senderId: String(message.senderUserId),
            senderName,
          },
        });
      } catch (e: any) {
        console.warn('[message] CRM notify failed:', e?.message || e);
      }
      return;
    }

    // Staff → guard/client: device push.
    const { pushToUser } = require('./pushService');
    await pushToUser(db, tenantId, recipientUserId, {
      title: senderName,
      body,
      data: {
        type: 'message.new',
        conversationId: String(conversation.id),
        messageId: String(message.id),
        senderId: String(message.senderUserId),
      },
    });
  } catch (e: any) {
    console.warn('[message] notify failed:', e?.message || e);
  }
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
  if (!opts.asAdmin) where.recipientUserId = viewerUserId;
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
  const hasMore = convos.length > limit;
  const page = hasMore ? convos.slice(0, limit) : convos;
  const rows = page.map((c: any) => {
    const p = c.get({ plain: true });
    const name = c.recipientGuard?.fullName
      || c.recipientClient?.commercialName
      || [c.recipientClient?.name, c.recipientClient?.lastName].filter(Boolean).join(' ')
      || (p.recipientType === 'guard' ? 'Guardia' : 'Cliente');
    return {
      id: p.id, recipientType: p.recipientType, recipientUserId: p.recipientUserId,
      recipientName: name, subject: p.subject, isOneWay: p.isOneWay,
      lastMessageAt: p.lastMessageAt, lastMessagePreview: p.lastMessagePreview,
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
  if (!asAdmin && viewerUserId && convo.recipientUserId !== viewerUserId && convo.createdById !== viewerUserId) {
    return null; // not a participant
  }
  return convo;
}

/** Keyset-paginated thread (newest first). */
export async function listMessages(
  db: any,
  tenantId: string,
  conversationId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<{ rows: any[]; nextCursor: string | null }> {
  const { Op } = db.Sequelize;
  const limit = Math.min(opts.limit || 30, 100);
  const where: any = { tenantId, conversationId, deletedAt: null };
  if (opts.before) where.createdAt = { [Op.lt]: new Date(opts.before) };

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
      body: p.body, createdAt: p.createdAt,
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
