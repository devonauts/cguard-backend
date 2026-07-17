/** @openapi { "summary": "Card metadata for the clients CARDS view (logo + site/station counts)", "responses": { "200": { "description": "Per-client logo + counts" } } } */

/**
 * GET /tenant/:tenantId/client-account/card-meta?ids=a,b,c
 *
 * Companion to the clients LIST (which deliberately strips file relations for
 * payload perf): the CRM cards view fetches this once per page of results.
 * Returns, per client id: the signed logo URL (first logoUrl file) and how
 * big their operation is (sites + stations — stations count via the client's
 * post-sites AND direct stationOrigin links, deduped).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { batchSignFiles } from '../../database/utils/listQuery';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountRead);
    const db = req.database;
    const tenantId = req.currentTenant?.id;
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) return ApiResponseHandler.success(req, res, {});

    // Scope to the tenant: only ids that really belong here get meta back.
    const owned = await db.clientAccount.findAll({
      where: { tenantId, id: ids },
      attributes: ['id'],
    });
    const ownedIds: string[] = owned.map((c: any) => String(c.id));
    if (!ownedIds.length) return ApiResponseHandler.success(req, res, {});

    // Logos (signed) — batchSignFiles fills row.logoUrl with the file array.
    const logoRows: any[] = ownedIds.map((id) => ({ id }));
    await batchSignFiles(db, logoRows, db.clientAccount.getTableName(), 'logoUrl');

    // Sites per client.
    const [siteCounts]: any = await db.sequelize.query(
      `SELECT clientAccountId AS cid, COUNT(*) AS n
         FROM businessInfos
        WHERE tenantId = :tenantId AND deletedAt IS NULL AND clientAccountId IN (:ids)
        GROUP BY clientAccountId`,
      { replacements: { tenantId, ids: ownedIds } },
    );

    // Stations per client: via their post-sites OR direct stationOrigin link.
    const [stationCounts]: any = await db.sequelize.query(
      `SELECT cid, COUNT(*) AS n FROM (
         SELECT s.id, COALESCE(b.clientAccountId, s.stationOriginId) AS cid
           FROM stations s
      LEFT JOIN businessInfos b ON b.id = s.postSiteId AND b.deletedAt IS NULL
          WHERE s.tenantId = :tenantId AND s.deletedAt IS NULL
       ) x
        WHERE cid IN (:ids)
        GROUP BY cid`,
      { replacements: { tenantId, ids: ownedIds } },
    );

    const sitesBy: Record<string, number> = {};
    for (const r of siteCounts || []) sitesBy[String(r.cid)] = Number(r.n) || 0;
    const stationsBy: Record<string, number> = {};
    for (const r of stationCounts || []) stationsBy[String(r.cid)] = Number(r.n) || 0;

    const out: Record<string, any> = {};
    for (const row of logoRows) {
      const files = Array.isArray(row.logoUrl) ? row.logoUrl : [];
      out[row.id] = {
        logoUrl: files[0]?.downloadUrl || null,
        sites: sitesBy[row.id] || 0,
        stations: stationsBy[row.id] || 0,
      };
    }

    await ApiResponseHandler.success(req, res, out);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
