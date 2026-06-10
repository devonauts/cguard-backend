/**
 * GET /tenant/:tenantId/security/audit-logs?userId=&event=&limit=
 * The tenant's security/auth audit trail (logins, logouts, device events, etc.).
 * Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const q = req.query || {};
    const where: any = { tenantId };
    if (q.userId) where.userId = q.userId;
    if (q.event) where.event = q.event;
    const limit = Math.min(Number(q.limit) || 100, 500);

    const rows = await db.securityAuditLog.findAll({ where, order: [['at', 'DESC']], limit });
    await ApiResponseHandler.success(req, res, (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r)));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
