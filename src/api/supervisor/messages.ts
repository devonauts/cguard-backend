/**
 * Supervisor messaging — the supervisor is STAFF but gets a PRIVATE inbox, NOT
 * the shared CRM team inbox. Every call is scoped to the signed-in supervisor
 * (asAdmin:false → they only ever see conversations they're the recipient of,
 * created, or are a group member of). Bodies are encrypted at rest. Per-user
 * delete hides a conversation for this supervisor only. Gated `supervisorMe`.
 *
 *   GET    /supervisor/me/messages                      → my conversations
 *   POST   /supervisor/me/messages                      → start a thread (recipientType/Id)
 *   GET    /supervisor/me/messages/:id                  → a thread I'm in
 *   POST   /supervisor/me/messages/:id                  → reply
 *   POST   /supervisor/me/messages/:id/read             → mark read
 *   DELETE /supervisor/me/messages/:id                  → delete for me (hide)
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import {
  listConversations,
  getConversation,
  listMessages,
  sendMessage,
  getOrCreateConversation,
  markRead,
  hideConversationForUser,
} from '../../services/messageService';

const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id, userId: req.currentUser.id });
const gate = (req: any) => new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);

export const supMessageList = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const q = req.query || {};
    const data = await listConversations(db, tenantId, userId, {
      asAdmin: false, // PRIVATE inbox — never the shared CRM inbox.
      limit: parseInt(q.limit, 10) || 50,
      cursor: q.cursor || null,
      q: q.q || null,
    });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const supMessageCreate = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    if (!body.recipientType || !body.recipientId) throw new Error400(req.language, 'recipientType y recipientId son obligatorios');
    const conversation = await getOrCreateConversation(db, tenantId, userId, {
      recipientType: body.recipientType, recipientId: body.recipientId, subject: body.subject, isOneWay: body.isOneWay,
    });
    const message = await sendMessage(db, tenantId, { conversation, senderUserId: userId, senderType: 'staff', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    await ApiResponseHandler.success(req, res, { conversationId: conversation.id, conversation, message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const supMessageGet = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) throw new Error400(req.language, 'conversation.notFound');
    const c = convo.get ? convo.get({ plain: true }) : convo;
    await ApiResponseHandler.success(req, res, {
      conversation: { id: c.id, subject: c.subject, isOneWay: c.isOneWay, recipientType: c.recipientType, recipientName: c.recipientName, kind: c.kind, isGroup: c.kind === 'group', memberCount: c.memberCount, encrypted: true },
    });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const supMessageThread = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) throw new Error400(req.language, 'conversation.notFound');
    const q = req.query || {};
    const data = await listMessages(db, tenantId, req.params.conversationId, { limit: parseInt(q.limit, 10) || 40, before: q.before || null, viewerUserId: userId });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const supMessageReply = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) throw new Error400(req.language, 'conversation.notFound');
    const body = req.body?.data || req.body || {};
    const message = await sendMessage(db, tenantId, { conversation: convo, senderUserId: userId, senderType: 'staff', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    await ApiResponseHandler.success(req, res, { message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const supMessageMarkRead = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) throw new Error400(req.language, 'conversation.notFound');
    const markedCount = await markRead(db, tenantId, req.params.conversationId, userId);
    await ApiResponseHandler.success(req, res, { markedCount });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** Delete the conversation FOR THIS SUPERVISOR ONLY (WhatsApp-style hide). */
export const supMessageDelete = async (req: any, res: any) => {
  try {
    gate(req);
    const { db, tenantId, userId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) throw new Error400(req.language, 'conversation.notFound');
    await hideConversationForUser(db, tenantId, userId, req.params.conversationId);
    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
