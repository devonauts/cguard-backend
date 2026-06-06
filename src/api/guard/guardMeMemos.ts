/**
 * GET /api/tenant/:tenantId/guard/me/memos
 * Memos addressed to the authenticated guard, newest first, each with its
 * acknowledgment status. Drives the worker-app "Memos" list.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });
    if (!securityGuard) return ApiResponseHandler.success(req, res, { rows: [], count: 0 });

    const memos = await db.memos.findAll({
      where: { tenantId, guardNameId: securityGuard.id, deletedAt: null },
      include: [{ model: db.user, as: 'createdBy', attributes: ['id', 'firstName', 'lastName', 'email'] }],
      order: [['dateTime', 'DESC'], ['createdAt', 'DESC']],
      limit: 100,
    });

    const rows = memos.map((m: any) => {
      const p = m.get({ plain: true });
      const author = p.createdBy
        ? `${p.createdBy.firstName || ''} ${p.createdBy.lastName || ''}`.trim() || p.createdBy.email
        : null;
      return {
        id: p.id,
        subject: p.subject,
        content: p.content,
        dateTime: p.dateTime || p.createdAt,
        wasAccepted: !!p.wasAccepted,
        createdByName: author,
      };
    });

    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
