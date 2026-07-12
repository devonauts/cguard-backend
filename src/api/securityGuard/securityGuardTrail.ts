/**
 * GET /tenant/:tenantId/security-guard/:id/trail?from&to&limit
 *
 * The walked GPS trail (breadcrumbs) for one guard over a time window — the
 * ACTUAL route, not the single last-known dot the live map shows. Ordered by
 * time ascending so the CRM can draw a polyline. Defaults to the last 12h,
 * capped at 5000 points.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.guardShiftRead);

    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const guardId = req.params.id;

    const now = Date.now();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(now - 12 * 3600 * 1000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(now);
    const limit = Math.min(parseInt(String(req.query.limit || '5000'), 10) || 5000, 5000);

    if (!db.locationPing) {
      // Table not migrated yet — return an empty trail rather than 500.
      return ApiResponseHandler.success(req, res, { points: [], count: 0 });
    }

    const { Op } = require('sequelize');
    const rows = await db.locationPing.findAll({
      where: {
        tenantId,
        securityGuardId: guardId,
        recordedAt: { [Op.gte]: from, [Op.lte]: to },
      },
      attributes: ['latitude', 'longitude', 'recordedAt', 'speed', 'accuracy', 'battery'],
      order: [['recordedAt', 'ASC']],
      limit,
    });

    const points = rows.map((r: any) => ({
      lat: r.latitude,
      lng: r.longitude,
      at: r.recordedAt,
      speed: r.speed,
      accuracy: r.accuracy,
      battery: r.battery,
    }));

    await ApiResponseHandler.success(req, res, { points, count: points.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
