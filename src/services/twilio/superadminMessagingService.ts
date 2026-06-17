/**
 * Platform Twilio SMS persistence + realtime fan-out (SuperAdmin phone center).
 *
 * Maps Twilio webhook + composer activity onto twilioConversation /
 * twilioMessage rows and emits live updates to all superadmin browsers via
 * emitSuperadminEvent. Platform-scoped (no tenant filter) — `database` is the
 * models bag from req.database.
 *
 * Socket events emitted (EXACT names — frontend listens for these):
 *   'twilio:sms:inbound'   { conversationId, message }
 *   'twilio:sms:status'    { twilioSid, status }
 *   'twilio:sms:outbound'  { conversationId, message }
 */
import { emitSuperadminEvent } from '../../lib/realtime';

function preview(body: string | null | undefined): string {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 255);
}

/** A plain, frontend-friendly shape for a message row. */
function serializeMessage(m: any) {
  if (!m) return null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    fromNumber: m.fromNumber,
    toNumber: m.toNumber,
    body: m.body,
    twilioSid: m.twilioSid,
    status: m.status,
    mediaUrls: m.mediaUrls || null,
    errorMessage: m.errorMessage || null,
    createdAt: m.createdAt,
  };
}

function serializeConversation(c: any) {
  if (!c) return null;
  return {
    id: c.id,
    peerNumber: c.peerNumber,
    ourNumber: c.ourNumber,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    unreadCount: c.unreadCount,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Find (or create) the conversation thread for a peer on our platform number. */
export async function getOrCreateConversation(
  database: any,
  peerNumber: string,
  ourNumber?: string,
): Promise<any> {
  const where: any = { peerNumber: String(peerNumber || '').trim() };
  const [conv] = await database.twilioConversation.findOrCreate({
    where,
    defaults: {
      peerNumber: where.peerNumber,
      ourNumber: ourNumber ? String(ourNumber).trim() : null,
      status: 'open',
      unreadCount: 0,
    },
  });
  if (ourNumber && !conv.ourNumber) {
    await conv.update({ ourNumber: String(ourNumber).trim() });
  }
  return conv;
}

export interface RecordInboundArgs {
  from: string;
  to: string;
  body: string;
  twilioSid?: string;
  mediaUrls?: string[] | null;
}

/**
 * Persist an inbound SMS (peer → us), bump the thread's unread count + preview,
 * and emit 'twilio:sms:inbound'. Returns { conversation, message }.
 */
export async function recordInbound(database: any, args: RecordInboundArgs) {
  const conv = await getOrCreateConversation(database, args.from, args.to);
  const message = await database.twilioMessage.create({
    conversationId: conv.id,
    direction: 'inbound',
    fromNumber: args.from,
    toNumber: args.to,
    body: args.body || '',
    twilioSid: args.twilioSid || null,
    status: 'received',
    mediaUrls: args.mediaUrls && args.mediaUrls.length ? args.mediaUrls : null,
  });

  await conv.update({
    lastMessageAt: new Date(),
    lastMessagePreview: preview(args.body),
    unreadCount: (conv.unreadCount || 0) + 1,
    status: conv.status === 'closed' ? 'open' : conv.status,
  });

  const payload = { conversationId: conv.id, message: serializeMessage(message) };
  emitSuperadminEvent('twilio:sms:inbound', payload);
  return { conversation: serializeConversation(conv), message: payload.message };
}

export interface RecordOutboundArgs {
  to: string;
  body: string;
  twilioSid?: string;
  status?: string;
  ourNumber?: string;
}

/**
 * Persist an outbound SMS (us → peer), update the thread preview, and emit
 * 'twilio:sms:outbound' so other open superadmin tabs sync. Returns
 * { conversation, message }.
 */
export async function recordOutbound(database: any, args: RecordOutboundArgs) {
  const conv = await getOrCreateConversation(database, args.to, args.ourNumber);
  const message = await database.twilioMessage.create({
    conversationId: conv.id,
    direction: 'outbound',
    fromNumber: args.ourNumber || conv.ourNumber || null,
    toNumber: args.to,
    body: args.body || '',
    twilioSid: args.twilioSid || null,
    status: args.status || 'queued',
  });

  await conv.update({
    lastMessageAt: new Date(),
    lastMessagePreview: preview(args.body),
  });

  const payload = { conversationId: conv.id, message: serializeMessage(message) };
  emitSuperadminEvent('twilio:sms:outbound', payload);
  return { conversation: serializeConversation(conv), message: payload.message };
}

/** Paginated conversation list, most-recent first. */
export async function listConversations(
  database: any,
  opts: { page?: number; limit?: number } = {},
) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const { rows, count } = await database.twilioConversation.findAndCountAll({
    order: [
      ['lastMessageAt', 'DESC'],
      ['updatedAt', 'DESC'],
    ],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    rows: rows.map(serializeConversation),
    count,
    page,
    limit,
  };
}

/** Paginated messages for a conversation, oldest → newest within the page. */
export async function listMessages(
  database: any,
  conversationId: string,
  opts: { page?: number; limit?: number } = {},
) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const { rows, count } = await database.twilioMessage.findAndCountAll({
    where: { conversationId },
    order: [['createdAt', 'ASC']],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    rows: rows.map(serializeMessage),
    count,
    page,
    limit,
  };
}

/** Clear a conversation's unread badge. Returns the serialized conversation. */
export async function markRead(database: any, conversationId: string) {
  const conv = await database.twilioConversation.findByPk(conversationId);
  if (!conv) return null;
  if (conv.unreadCount !== 0) await conv.update({ unreadCount: 0 });
  return serializeConversation(conv);
}

/**
 * Apply a Twilio status callback to an outbound message (matched by SID) and
 * emit 'twilio:sms:status'. Best-effort: no-op if the SID isn't found.
 */
export async function updateMessageStatus(
  database: any,
  twilioSid: string,
  status: string,
  errorMessage?: string,
) {
  if (!twilioSid) return null;
  const msg = await database.twilioMessage.findOne({ where: { twilioSid } });
  if (msg) {
    const patch: any = { status };
    if (errorMessage) patch.errorMessage = errorMessage;
    await msg.update(patch);
  }
  emitSuperadminEvent('twilio:sms:status', { twilioSid, status });
  return msg ? serializeMessage(msg) : null;
}

export default {
  getOrCreateConversation,
  recordInbound,
  recordOutbound,
  listConversations,
  listMessages,
  markRead,
  updateMessageStatus,
};
