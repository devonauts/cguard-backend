/** @openapi { "summary": "Client operation tree: sites with their stations (one call for the overview drill-down)", "responses": { "200": { "description": "sites[] each with stations[]; looseStations[] linked directly to the client" } } } */

/**
 * GET /tenant/:tenantId/client-account/:id/operation
 *
 * The client → site → station journey used to take 4-5 navigations; the
 * client overview now renders the WHOLE operation from this single call,
 * with deep links straight to each station.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountRead);
    const db = req.database;
    const tenantId = req.currentTenant?.id;
    const clientId = req.params.id;

    const client = await db.clientAccount.findOne({
      where: { id: clientId, tenantId },
      attributes: ['id'],
    });
    if (!client) throw new Error404();

    const sites = await db.businessInfo.findAll({
      where: { tenantId, clientAccountId: clientId },
      attributes: ['id', 'name', 'address', 'city', 'active'],
      order: [['name', 'ASC']],
    });
    const siteIds = sites.map((s: any) => s.id);

    const { Op } = db.Sequelize;
    const stationWhere: any[] = [{ stationOriginId: clientId }];
    if (siteIds.length) stationWhere.push({ postSiteId: { [Op.in]: siteIds } });
    const stations = await db.station.findAll({
      where: { tenantId, [Op.or]: stationWhere },
      attributes: [
        'id', 'stationName', 'nickname', 'postSiteId', 'stationOriginId',
        'numberOfGuardsInStation', 'scheduleType', 'startingTimeInDay', 'finishTimeInDay', 'isMobile',
      ],
      order: [['stationName', 'ASC']],
    });

    const bySite = new Map<string, any[]>();
    const loose: any[] = [];
    for (const st of stations) {
      const plain = st.get ? st.get({ plain: true }) : st;
      if (plain.postSiteId && siteIds.includes(plain.postSiteId)) {
        if (!bySite.has(String(plain.postSiteId))) bySite.set(String(plain.postSiteId), []);
        bySite.get(String(plain.postSiteId))!.push(plain);
      } else {
        loose.push(plain);
      }
    }

    await ApiResponseHandler.success(req, res, {
      sites: sites.map((s: any) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        city: s.city,
        active: s.active,
        stations: bySite.get(String(s.id)) || [],
      })),
      // Stations linked to the client without a post-site (some tenants skip
      // the site level entirely — they must still show up).
      looseStations: loose,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
