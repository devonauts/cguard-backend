import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import { createGroupConversation, sendMessage, getConversation } from '../../services/messageService';
import {
  syncGroupMembership,
  listParticipants,
  upsertParticipant,
  classifyMember,
} from '../../services/groupMembershipService';

/**
 * Tenant-only group-chat management. Guards/clients can participate in groups
 * (via the guard endpoints) but only staff can create or manage them — every
 * handler here is gated by messageSend and lives under the admin message API.
 */
const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id, userId: req.currentUser.id });

/** Load a group conversation or throw a 404. */
async function loadGroup(db: any, tenantId: string, conversationId: string) {
  const convo = await getConversation(db, tenantId, conversationId, undefined, true);
  if (!convo || convo.kind !== 'group') { const e: any = new Error('Grupo no encontrado'); e.code = 404; throw e; }
  return convo;
}

/** POST /tenant/:tenantId/message/groups — create a group + derive membership. */
export const groupCreate = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return ApiResponseHandler.error(req, res, Object.assign(new Error('El nombre del grupo es obligatorio'), { code: 400 }));
    }
    if (!body.anchorId && !(Array.isArray(body.extraMemberUserIds) && body.extraMemberUserIds.length)) {
      return ApiResponseHandler.error(req, res, Object.assign(new Error('Selecciona un puesto/estación o añade miembros'), { code: 400 }));
    }

    const conversation = await createGroupConversation(db, tenantId, userId, {
      name: body.name, anchorType: body.anchorType || null, anchorId: body.anchorId || null, isOneWay: body.isOneWay,
    });

    // Derive guards from the anchor (post site / station).
    if (body.anchorId) await syncGroupMembership(db, conversation.id, tenantId);

    // Add any extra manual members (resolve staff vs guard automatically).
    if (Array.isArray(body.extraMemberUserIds)) {
      for (const uid of body.extraMemberUserIds.filter(Boolean)) {
        const cls = await classifyMember(db, tenantId, String(uid));
        await upsertParticipant(db, tenantId, conversation.id, String(uid), { ...cls, role: 'member', source: 'manual', actorId: userId });
      }
    }

    // Optional first message.
    let message: any = null;
    if ((body.body && String(body.body).trim()) || (Array.isArray(body.attachments) && body.attachments.length)) {
      message = await sendMessage(db, tenantId, { conversation, senderUserId: userId, senderType: 'staff', body: body.body, clientMsgId: body.clientMsgId, attachments: body.attachments });
    }

    const members = await listParticipants(db, tenantId, conversation.id);
    await ApiResponseHandler.success(req, res, {
      conversation: conversation.get({ plain: true }),
      members,
      message: message && message.get ? message.get({ plain: true }) : message,
    });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /tenant/:tenantId/message/groups/:conversationId/members */
export const groupMembersList = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageRead);
    const { db, tenantId } = ctx(req);
    await loadGroup(db, tenantId, req.params.conversationId);
    const members = await listParticipants(db, tenantId, req.params.conversationId);
    await ApiResponseHandler.success(req, res, { rows: members });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /tenant/:tenantId/message/groups/:conversationId/members — add manual member(s). */
export const groupMembersAdd = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId, userId } = ctx(req);
    await loadGroup(db, tenantId, req.params.conversationId);
    const body = req.body?.data || req.body || {};
    const ids: string[] = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
    if (!ids.length) return ApiResponseHandler.error(req, res, Object.assign(new Error('userIds es obligatorio'), { code: 400 }));
    for (const uid of ids.filter(Boolean)) {
      const cls = await classifyMember(db, tenantId, String(uid));
      await upsertParticipant(db, tenantId, req.params.conversationId, String(uid), { ...cls, role: 'member', source: 'manual', actorId: userId });
    }
    const members = await listParticipants(db, tenantId, req.params.conversationId);
    await ApiResponseHandler.success(req, res, { rows: members });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** DELETE /tenant/:tenantId/message/groups/:conversationId/members/:userId */
export const groupMemberRemove = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId } = ctx(req);
    await loadGroup(db, tenantId, req.params.conversationId);
    const part = await db.messageConversationParticipant.findOne({
      where: { tenantId, conversationId: req.params.conversationId, userId: req.params.userId, deletedAt: null },
    });
    if (part) await part.destroy();
    const members = await listParticipants(db, tenantId, req.params.conversationId);
    await ApiResponseHandler.success(req, res, { rows: members });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /tenant/:tenantId/message/groups/:conversationId/resync — re-derive from anchor. */
export const groupResync = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.messageSend);
    const { db, tenantId } = ctx(req);
    await loadGroup(db, tenantId, req.params.conversationId);
    await syncGroupMembership(db, req.params.conversationId, tenantId);
    const members = await listParticipants(db, tenantId, req.params.conversationId);
    await ApiResponseHandler.success(req, res, { rows: members });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
