/**
 * GET /tenant/:tenantId/security/audit-logs?userId=&event=&search=&limit=&offset=
 * The tenant's security/auth audit trail (logins, logouts, device events, etc.).
 * Tenant-scoped; requires businessInfoRead. Returns { rows, count } for paging.
 *   - event: single value or comma-separated list (e.g. "device_registered,device_evicted")
 *   - search: ilike across email / ip / platform / detail
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Sequelize from 'sequelize';

const Op = Sequelize.Op;

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const q = req.query || {};

    const whereAnd: any[] = [{ tenantId }];
    if (q.userId) whereAnd.push({ userId: q.userId });

    if (q.event) {
      const events = String(q.event).split(',').map((e) => e.trim()).filter(Boolean);
      if (events.length === 1) whereAnd.push({ event: events[0] });
      else if (events.length > 1) whereAnd.push({ event: { [Op.in]: events } });
    }

    if (q.search) {
      const s = `%${String(q.search).toLowerCase()}%`;
      whereAnd.push({
        [Op.or]: [
          Sequelize.where(Sequelize.fn('lower', Sequelize.col('email')), { [Op.like]: s }),
          Sequelize.where(Sequelize.fn('lower', Sequelize.col('ip')), { [Op.like]: s }),
          Sequelize.where(Sequelize.fn('lower', Sequelize.col('platform')), { [Op.like]: s }),
          Sequelize.where(Sequelize.fn('lower', Sequelize.col('detail')), { [Op.like]: s }),
        ],
      });
    }

    const limit = Math.min(Number(q.limit) || 100, 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const { rows, count } = await db.securityAuditLog.findAndCountAll({
      where: { [Op.and]: whereAnd },
      order: [['at', 'DESC']],
      limit,
      offset,
    });

    await ApiResponseHandler.success(req, res, {
      rows: (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r)),
      count,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
