import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';

/**
 * GET /tenant/:tenantId/client-account/:id/guards/count
 *
 * Distinct guards ASSIGNED to the client's stations (active guardAssignment) —
 * the same source of truth as personnel/operation/overview. The old
 * implementation counted rows of `tenant_user_client_accounts`, which is the
 * CLIENT-APP ACCESS pivot (rep legal/titular/extras), not a guard roster.
 */
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const tenant = SequelizeRepository.getCurrentTenant(req);
    const clientId = req.params.id;
    const db = req.database;
    const { Op } = db.Sequelize;

    const sites = await db.businessInfo.findAll({
      where: { clientAccountId: clientId, tenantId: tenant.id },
      attributes: ['id'],
    }).catch(() => []);
    const siteIds = (sites || []).map((s: any) => s.id).filter(Boolean);

    const stationWhere: any[] = [{ stationOriginId: clientId }];
    if (siteIds.length) stationWhere.push({ postSiteId: siteIds });
    const stations = await db.station.findAll({
      where: { tenantId: tenant.id, [Op.or]: stationWhere },
      attributes: ['id'],
    }).catch(() => []);
    const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);

    let count = 0;
    if (stationIds.length) {
      const assigns = await db.guardAssignment.findAll({
        where: { tenantId: tenant.id, stationId: stationIds, status: 'active' },
        attributes: ['guardId'],
      }).catch(() => []);
      count = new Set((assigns || []).map((a: any) => String(a.guardId))).size;
    }

    await ApiResponseHandler.success(req, res, { count });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
