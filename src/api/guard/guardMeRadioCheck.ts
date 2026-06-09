/**
 * Worker-app radio check (the guard answers the pase de novedades).
 * GET  /guard/me/radio-check/pending                  → my active request (if any)
 * POST /guard/me/radio-check/entries/:entryId/reply   → voice/canned/text reply
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { getPendingForGuard, submitReply } from '../../services/radioCheckService';

const guardCtx = (req: any) => {
  if (!req.currentUser) throw new Error401();
  return {
    db: req.database,
    tenantId: req.params.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: req.currentUser.id,
  };
};

export const guardRadioPending = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const entry = await getPendingForGuard(db, tenantId, userId);
    await ApiResponseHandler.success(req, res, { entry: entry ? (entry.get ? entry.get({ plain: true }) : entry) : null });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

export const guardRadioReply = async (req, res) => {
  try {
    const { db, tenantId, userId } = guardCtx(req);
    const body = req.body?.data || req.body || {};
    const entry = await submitReply(db, tenantId, req.params.entryId, userId, {
      audioUrl: body.audioUrl || null,
      cannedText: body.cannedText || null,
      text: body.text || null,
      clientMsgId: body.clientMsgId || null,
    });
    await ApiResponseHandler.success(req, res, { entry: entry.get ? entry.get({ plain: true }) : entry });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
