import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { geocodeAddress } from '../../lib/geocode';

/**
 * POST /tenant/:tenantId/security-guard/geocode-missing
 *
 * Backfill geocoded coordinates for guards that have an address but no lat/lng
 * yet (proximity ranking). Processes a small batch per call (Nominatim is rate-
 * limited to ~1 req/s), returns how many were geocoded and how many remain so
 * the caller can run it again until `remaining` is 0.
 */
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const { Op } = db.Sequelize;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 25);

    const where = { tenantId, deletedAt: null, latitude: null, address: { [Op.ne]: null } };
    const guards = await db.securityGuard.findAll({ where, attributes: ['id', 'address'], limit });

    let geocoded = 0;
    for (const g of guards) {
      if (!g.address || String(g.address).trim().length < 4) continue;
      const pt = await geocodeAddress(g.address);
      if (pt) {
        await db.securityGuard.update(
          { latitude: pt.latitude, longitude: pt.longitude },
          { where: { id: g.id, tenantId } },
        );
        geocoded++;
      }
      // Respect Nominatim's ~1 req/s policy.
      await new Promise((r) => setTimeout(r, 1100));
    }

    const remaining = await db.securityGuard.count({ where });
    await ApiResponseHandler.success(req, res, { processed: guards.length, geocoded, remaining });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
