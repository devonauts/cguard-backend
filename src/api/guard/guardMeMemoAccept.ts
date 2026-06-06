/**
 * POST /api/tenant/:tenantId/guard/me/memos/:id/accept
 * The authenticated guard acknowledges (accepts) a memo addressed to them.
 * Sets wasAccepted = true and notifies the tenant so supervisors see the receipt.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const memoId = req.params.id;

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    if (!securityGuard) throw new Error400(req.language, 'guard.notAGuard');

    const memo = await db.memos.findOne({
      where: { id: memoId, tenantId, guardNameId: securityGuard.id, deletedAt: null },
    });
    if (!memo) throw new Error400(req.language, 'guard.memoNotFound');

    if (!memo.wasAccepted) {
      await memo.update({ wasAccepted: true });

      // notify tenant of the acknowledgment (best-effort, never blocks)
      try {
        const { pushToTenant } = require('../../services/pushService');
        await pushToTenant(db, tenantId, {
          title: 'Memo confirmado',
          body: `${securityGuard.fullName || currentUser.fullName || 'Un guardia'} confirmó: ${memo.subject || 'Memo'}`,
          data: { type: 'memo.accepted', memoId },
        });
      } catch { /* ignore */ }
    }

    return ApiResponseHandler.success(req, res, memo.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
