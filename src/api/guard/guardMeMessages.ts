/**
 * Worker-app messaging (the guard is a conversation recipient).
 * GET    /guard/me/messages                      → my inbox
 * GET    /guard/me/messages/:conversationId      → a thread I'm in
 * POST   /guard/me/messages/:conversationId      → reply (blocked if one-way)
 * POST   /guard/me/messages/:conversationId/read → mark inbound read
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import {
  listConversations,
  getConversation,
  listMessages,
  sendMessage,
  markRead,
} from '../../services/messageService';

const guardCtx = (req: any) => {
  if (!req.currentUser) throw new Error401();
  return {
    db: req.database,
    tenantId: req.params.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: req.currentUser.id,
  };
};

// A missing/unreachable thread is a 404, not a 500 — return a clean status and
// keep it out of the error log (stale clients can poll bad ids harmlessly).
const notFound = () => {
  const e: any = new Error('Conversación no encontrada');
  e.code = 404;
  return e;
};

export const guardMessagesList = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const q = req.query || {};
    const data = await listConversations(db, tenantId, userId, { asAdmin: false, limit: parseInt(q.limit, 10) || 25, cursor: q.cursor || null });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const guardMessageThread = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) return ApiResponseHandler.error(req, res, notFound());
    const q = req.query || {};
    const data = await listMessages(db, tenantId, req.params.conversationId, { limit: parseInt(q.limit, 10) || 30, before: q.before || null });
    const c = convo.get({ plain: true });
    await ApiResponseHandler.success(req, res, {
      conversation: { id: c.id, subject: c.subject, isOneWay: c.isOneWay, recipientType: c.recipientType },
      rows: data.rows,
      nextCursor: data.nextCursor,
    });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const guardMessageReply = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const convo = await getConversation(db, tenantId, req.params.conversationId, userId, false);
    if (!convo) return ApiResponseHandler.error(req, res, notFound());
    const body = req.body?.data || req.body || {};
    const message = await sendMessage(db, tenantId, { conversation: convo, senderUserId: userId, senderType: 'guard', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    await ApiResponseHandler.success(req, res, { message: message.get ? message.get({ plain: true }) : message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const guardMessageRead = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const markedCount = await markRead(db, tenantId, req.params.conversationId, userId);
    await ApiResponseHandler.success(req, res, { ok: true, markedCount });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
