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
  getOrCreateConversation,
  listMessages,
  sendMessage,
  markRead,
} from '../../services/messageService';
import { resolveSupervisorUserIds } from '../../services/communication/operationalRecipients';

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

// Client starts a new message to the office. Mirrors guardMessageCreate: we reuse
// the client's existing admin↔client thread when one exists, otherwise open one
// owned by an office admin so it lands in the CRM "Mensajes de Clientes" inbox and
// that owner gets the bell. The client is always the conversation recipient, so
// the thread also shows in their own app. Supports text and/or attachments.
export const customerMessageCreate = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const body = req.body?.data || req.body || {};
    if ((!body.body || !String(body.body).trim()) && !(Array.isArray(body.attachments) && body.attachments.length)) {
      const e: any = new Error('El mensaje no puede estar vacío'); e.code = 400; throw e;
    }
    const officeAdmins = await resolveSupervisorUserIds(db, tenantId);
    const ownerId = officeAdmins[0] || userId;
    const conversation = await getOrCreateConversation(db, tenantId, ownerId, {
      recipientType: 'client',
      recipientId: clientAccountId,
      subject: body.subject ? String(body.subject).slice(0, 200) : 'Mensaje al equipo',
    });
    const message = await sendMessage(db, tenantId, {
      conversation,
      senderUserId: userId,
      senderType: 'client',
      body: body.body,
      clientMsgId: body.clientMsgId,
      attachments: body.attachments,
    });
    await ApiResponseHandler.success(req, res, {
      conversationId: conversation.id,
      message: message.get ? message.get({ plain: true }) : message,
    });
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
    const message = await sendMessage(db, tenantId, { conversation: convo, senderUserId: userId, senderType: 'client', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
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
    // The native Mi Seguridad app also posts its RAW APNs token (hex) for direct
    // APNs delivery. It may arrive in its own request (separate from the FCM token),
    // so accept a post that carries only apnsToken.
    const apnsToken = (b.apnsToken || '').toString().trim();
    if (!token && !apnsToken) return ApiResponseHandler.error(req, res, new Error('deviceId o apnsToken requerido'));

    const fields: any = {
      app: 'client', // this endpoint only serves the Mi Seguridad client app
      lastSeenAt: new Date(),
      updatedById: userId,
    };
    if (token) {
      fields.deviceId = token;
      fields.pushToken = token;
    }
    if (apnsToken) fields.apnsToken = apnsToken;
    // Link the device to the client account directly so push can resolve it by
    // clientAccountId, independent of clientAccount.userId being set.
    if (clientAccountId) fields.clientAccountId = clientAccountId;
    const platform = b.platform ? String(b.platform).slice(0, 40) : '';
    if (platform) fields.platform = platform;
    if (b.model) fields.model = String(b.model).slice(0, 120);
    if (b.osVersion) fields.osVersion = String(b.osVersion).slice(0, 60);
    if (b.appVersion) fields.appVersion = String(b.appVersion).slice(0, 40);

    // An FCM (Android/web) device never carries an APNs token — clear any stale one so the
    // row stays FCM-deliverable.
    const isApple = /ios|apple|iphone|ipad/i.test(platform);
    if (token && !apnsToken && !isApple) fields.apnsToken = null;

    // Upsert keyed by the DEVICE's own token (the table has a UNIQUE (tenantId, deviceId)
    // index and the FCM token IS the device identity). Re-logging-in on the same physical
    // device then re-assigns that device row to the current user. The previous per-user
    // upsert tried to UPDATE the user's row and set a deviceId already owned by ANOTHER row
    // → ER_DUP_ENTRY, which failed silently (the app ignores the HTTP status) so the Android
    // token never landed and no push arrived. Re-assign userId, then fall back to apnsToken,
    // then (user, platform).
    fields.userId = userId;
    let existing: any = null;
    if (token) existing = await db.deviceIdInformation.findOne({ where: { tenantId, deviceId: token } });
    if (!existing && apnsToken) existing = await db.deviceIdInformation.findOne({ where: { tenantId, apnsToken } });
    if (!existing) existing = await db.deviceIdInformation.findOne({ where: platform ? { tenantId, userId, platform } : { tenantId, userId } });
    let current: any;
    if (existing) {
      await existing.update(fields);
      current = existing;
    } else {
      current = await db.deviceIdInformation.create({ ...fields, userId, tenantId, createdById: userId });
    }

    // Single device token per user: a login/registration on a new device REPLACES the old
    // one — delete every OTHER client device row for this user/account so only the latest
    // device receives push (matches single-device login: Apple → Android → … one at a time).
    try {
      const Op = db.Sequelize.Op;
      const orIds: any[] = [{ userId }];
      if (clientAccountId) orIds.push({ clientAccountId });
      await db.deviceIdInformation.destroy({
        where: { tenantId, app: 'client', [Op.or]: orIds, id: { [Op.ne]: current.id } },
      });
    } catch (e: any) {
      console.warn('[customerDeviceToken] prune old devices failed:', e?.message || e);
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
  } catch (error: any) {
    console.warn('[customerDeviceToken] failed:', error?.message);
    await ApiResponseHandler.error(req, res, error);
  }
};
