import PermissionChecker from '../../services/user/permissionChecker';
import businessNameOf, { CLIENT_LABEL_ATTRIBUTES } from '../../services/clientDisplayName';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Tenant-scoped read of customer-generated guard ratings, for the CRM.
 *
 *   GET /tenant/:tenantId/guard-ratings   query ?guardId=&limit=100
 *
 * The customer app writes guardRating rows (POST /customer/guards/:guardId/rating).
 * The customer read endpoint (customerGuardRatings.customerGuardRatingList) is scoped
 * to a single client's own feedback; THIS endpoint is scoped to the whole tenant so
 * the security company sees all client feedback per guard.
 *
 * Gated by securityGuardRead (all staff roles have it) via PermissionChecker —
 * mirrors src/api/request/requestList.ts.
 *
 * Returns { rows, count, average } where each row is joined with the guard fullName,
 * client/clientAccount name, station name, rating, comment and createdAt. Scoped to
 * the tenant; filtered by guardId when provided.
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);

    const db = req.database;
    const tenantId = req.currentTenant?.id;
    const guardId = req.query?.guardId ? String(req.query.guardId).trim() : null;
    const limit = Math.min(parseInt((req.query || {}).limit, 10) || 100, 500);

    const where: any = {
      ...(tenantId ? { tenantId } : {}),
      deletedAt: null,
      ...(guardId ? { guardId } : {}),
    };

    const rows = await db.guardRating.findAll({
      where,
      include: [
        { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'], required: false },
        { model: db.clientAccount, as: 'client', attributes: CLIENT_LABEL_ATTRIBUTES, required: false },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'], required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit,
    });

    const list = (rows || []).map((r: any) => {
      const plain = r.get({ plain: true });
      // "Cliente" = la empresa, no el representante legal.
      const clientName = plain.client ? (businessNameOf(plain.client) || null) : null;
      return {
        id: plain.id,
        guardId: plain.guardId || null,
        guardName: plain.guard ? plain.guard.fullName : null,
        clientAccountId: plain.clientAccountId || null,
        clientName,
        stationId: plain.stationId || null,
        stationName: plain.station ? plain.station.stationName : null,
        rating: plain.rating,
        comment: plain.comment || null,
        createdAt: plain.createdAt || null,
      };
    });

    const count = list.length;
    const average =
      count > 0
        ? Math.round((list.reduce((s, r) => s + (r.rating || 0), 0) / count) * 100) / 100
        : null;

    await ApiResponseHandler.success(req, res, { rows: list, count, average });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
