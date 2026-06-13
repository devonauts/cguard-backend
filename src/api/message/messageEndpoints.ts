import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import {
  getOrCreateConversation,
  sendMessage,
  listConversations,
  getConversation,
  listMessages,
  markRead,
  countUnread,
} from '../../services/messageService';

const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id, userId: req.currentUser.id });

/** GET /tenant/:tenantId/message — admin inbox (all tenant threads). */
export const messageList = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId, userId } = ctx(req);
    const q = req.query || {};
    const data = await listConversations(db, tenantId, userId, {
      asAdmin: true,
      limit: parseInt(q.limit, 10) || 25,
      cursor: q.cursor || null,
      recipientType: q.recipientType || null,
      q: q.q || null,
    });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /tenant/:tenantId/message — open (or reuse) a thread + send first message. */
export const messageCreate = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    if (!body.recipientType || !body.recipientId) {
      return ApiResponseHandler.error(req, res, new Error('recipientType y recipientId son obligatorios'));
    }
    const conversation = await getOrCreateConversation(db, tenantId, userId, {
      recipientType: body.recipientType, recipientId: body.recipientId, subject: body.subject, isOneWay: body.isOneWay,
    });
    const message = await sendMessage(db, tenantId, { conversation, senderUserId: userId, senderType: 'staff', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    await ApiResponseHandler.success(req, res, { conversation: conversation.get({ plain: true }), message: message.get ? message.get({ plain: true }) : message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /tenant/:tenantId/message/:conversationId — header. */
export const messageGet = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId } = ctx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, undefined, true);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    await ApiResponseHandler.success(req, res, convo.get({ plain: true }));
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /tenant/:tenantId/message/:conversationId/messages — thread (keyset). */
export const messageThread = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId } = ctx(req);
    const q = req.query || {};
    const data = await listMessages(db, tenantId, req.params.conversationId, { limit: parseInt(q.limit, 10) || 30, before: q.before || null });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /tenant/:tenantId/message/:conversationId/messages — reply. */
export const messageReply = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    const convo = await getConversation(db, tenantId, req.params.conversationId, undefined, true);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    const message = await sendMessage(db, tenantId, { conversation: convo, senderUserId: userId, senderType: 'staff', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    await ApiResponseHandler.success(req, res, { message: message.get ? message.get({ plain: true }) : message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /tenant/:tenantId/message/:conversationId/read — admin marks inbound read. */
export const messageMarkRead = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId, userId } = ctx(req);
    const markedCount = await markRead(db, tenantId, req.params.conversationId, userId);
    await ApiResponseHandler.success(req, res, { ok: true, markedCount });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** PATCH /tenant/:tenantId/message/:conversationId — archive/restore/one-way. */
export const messagePatch = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    const convo = await getConversation(db, tenantId, req.params.conversationId, undefined, true);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    const patch: any = { updatedById: userId };
    if (typeof body.isOneWay === 'boolean') patch.isOneWay = body.isOneWay;
    if (typeof body.archived === 'boolean') patch.archived = body.archived;
    await convo.update(patch);
    await ApiResponseHandler.success(req, res, convo.get({ plain: true }));
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** DELETE /tenant/:tenantId/message/:conversationId — delete a finished thread. */
export const messageDelete = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId } = ctx(req);
    const conversationId = req.params.conversationId;
    const convo = await getConversation(db, tenantId, conversationId, undefined, true);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    // Soft-delete the whole thread (models are paranoid → recoverable).
    await db.messageReceipt.destroy({ where: { tenantId, conversationId } });
    await db.message.destroy({ where: { tenantId, conversationId } });
    await convo.destroy();
    await ApiResponseHandler.success(req, res, { id: conversationId, deleted: true });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /tenant/:tenantId/message-unread — badge count for the current user. */
export const messageUnread = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId, userId } = ctx(req);
    const count = await countUnread(db, tenantId, userId);
    await ApiResponseHandler.success(req, res, { count });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
