import { fn, col, Op } from 'sequelize';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Per-guard rating aggregates for a set of guards, so any worker-detail surface
 * (Personal asignado, guard cards, guard list, hero) can show a review "level"
 * without N+1 queries.
 *
 *   GET /tenant/:tenantId/guard-ratings/summary?guardIds=a,b,c   (comma list)
 *   GET /tenant/:tenantId/guard-ratings/summary                  (all guards)
 *
 * Returns { summary: { [guardId]: { average, count } } }. guardId references
 * securityGuard.id. Gated by securityGuardRead (all staff roles have it).
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);

    const db = req.database;
    const tenantId = req.currentTenant?.id;
    const raw = req.query?.guardIds ? String(req.query.guardIds) : '';
    const guardIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const where: any = {
      ...(tenantId ? { tenantId } : {}),
      deletedAt: null,
      ...(guardIds.length ? { guardId: { [Op.in]: guardIds } } : {}),
    };

    const rows = await db.guardRating.findAll({
      where,
      attributes: [
        'guardId',
        [fn('AVG', col('rating')), 'avg'],
        [fn('COUNT', col('id')), 'cnt'],
      ],
      group: ['guardId'],
    });

    const summary: Record<string, { average: number; count: number }> = {};
    for (const r of rows || []) {
      const p = r.get ? r.get({ plain: true }) : r;
      if (!p.guardId) continue;
      summary[String(p.guardId)] = {
        average: Math.round((Number(p.avg) || 0) * 100) / 100,
        count: Number(p.cnt) || 0,
      };
    }

    await ApiResponseHandler.success(req, res, { summary });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
