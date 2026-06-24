/**
 * Client-app messaging API (the separate client project connects to these).
 * Auth = the customer JWT from /auth/sign-in-customer (currentUser.clientAccountId).
 * Every query is scoped by tenantId AND the client's own user.id / clientAccountId.
 *   GET  /customer/messages
 *   GET  /customer/messages/:conversationId
 *   POST /customer/messages/:conversationId          (reply, blocked if one-way)
 *   POST /customer/messages/:conversationId/read
 *   POST /customer/device-token                       (register client FCM token)
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import {
  listConversations,
  getConversation,
  listMessages,
  sendMessage,
  markRead,
} from '../../services/messageService';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return { db: req.database, tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id), userId: u.id, clientAccountId };
};

/** Verify the conversation belongs to this client account. */
async function ownedConvo(db: any, tenantId: string, conversationId: string, userId: string, clientAccountId: string) {
  const convo = await getConversation(db, tenantId, conversationId, userId, false);
  if (!convo || convo.recipientClientAccountId !== clientAccountId) return null;
  return convo;
}

export const customerMessagesList = async (req, res) => {
  try {
    const { db, tenantId, userId } = customerCtx(req);
    const q = req.query || {};
    const data = await listConversations(db, tenantId, userId, { asAdmin: false, limit: parseInt(q.limit, 10) || 25, cursor: q.cursor || null });
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const customerMessageThread = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const convo = await ownedConvo(db, tenantId, req.params.conversationId, userId, clientAccountId);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    const q = req.query || {};
    const data = await listMessages(db, tenantId, req.params.conversationId, { limit: parseInt(q.limit, 10) || 30, before: q.before || null });
    const c = convo.get({ plain: true });
    await ApiResponseHandler.success(req, res, { conversation: { id: c.id, subject: c.subject, isOneWay: c.isOneWay }, rows: data.rows, nextCursor: data.nextCursor });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const customerMessageReply = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const convo = await ownedConvo(db, tenantId, req.params.conversationId, userId, clientAccountId);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    const body = req.body?.data || req.body || {};
    const message = await sendMessage(db, tenantId, { conversation: convo, senderUserId: userId, senderType: 'client', body: body.body, clientMsgId: body.clientMsgId });
    await ApiResponseHandler.success(req, res, { message: message.get ? message.get({ plain: true }) : message });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const customerMessageRead = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const convo = await ownedConvo(db, tenantId, req.params.conversationId, userId, clientAccountId);
    if (!convo) return ApiResponseHandler.error(req, res, new Error('Conversación no encontrada'));
    const markedCount = await markRead(db, tenantId, req.params.conversationId, userId);
    await ApiResponseHandler.success(req, res, { ok: true, markedCount });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/**
 * Register the native client app's FCM token so CRM→client push is deliverable.
 * Customer-scoped (auth via the sign-in-customer JWT — no admin permission), so
 * the apps don't hit the permissioned /tenant/:id/device-id-information (403).
 * Accepts the apps' current body { deviceId } as well as { token }/{ pushToken },
 * plus optional device metadata. Keyed by (tenant, user): a refreshed token
 * overwrites the old row.
 */
export const customerDeviceToken = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};
    const token = (b.deviceId || b.token || b.pushToken || '').toString().trim();
    if (!token) return ApiResponseHandler.error(req, res, new Error('deviceId requerido'));

    const fields: any = {
      deviceId: token,
      pushToken: token,
      lastSeenAt: new Date(),
      updatedById: userId,
    };
    // Link the device to the client account directly so push can resolve it by
    // clientAccountId, independent of clientAccount.userId being set.
    if (clientAccountId) fields.clientAccountId = clientAccountId;
    if (b.platform) fields.platform = String(b.platform).slice(0, 40);
    if (b.model) fields.model = String(b.model).slice(0, 120);
    if (b.osVersion) fields.osVersion = String(b.osVersion).slice(0, 60);
    if (b.appVersion) fields.appVersion = String(b.appVersion).slice(0, 40);

    const existing = await db.deviceIdInformation.findOne({ where: { tenantId, userId } });
    if (existing) {
      await existing.update(fields);
    } else {
      await db.deviceIdInformation.create({ ...fields, userId, tenantId, createdById: userId });
    }

    // Link the clientAccount to this user so the push-notify path
    // (clientNotifyService → pushToUser, keyed by clientAccount.userId) resolves
    // THIS device. A clientAccount matched via the tenantUser pivot can have an
    // unset userId, which otherwise silently drops every client push even though
    // the token is stored — i.e. "no device token registered" from the push side.
    try {
      if (clientAccountId) {
        const ca = await db.clientAccount.findOne({ where: { id: clientAccountId, tenantId } });
        if (ca && !ca.userId) await ca.update({ userId });
      }
    } catch (e: any) {
      console.warn('[customerDeviceToken] clientAccount link failed:', e?.message || e);
    }

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
