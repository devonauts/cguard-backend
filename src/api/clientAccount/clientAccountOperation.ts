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
      // businessInfo's display name column is companyName (there is no `name`).
      attributes: ['id', 'companyName', 'address', 'city', 'active'],
      order: [['companyName', 'ASC']],
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

    // Vigilantes asignados from guardAssignment — the SINGLE source of truth.
    // (The old `assignedGuards` include read the LEGACY stationAssignedGuardsUser
    // pivot, which is dead data and showed phantom/stale guards here.)
    const stationIdList = stations.map((s: any) => String(s.id));
    const guardsByStation = new Map<string, { id: string; name: string }[]>();
    if (stationIdList.length) {
      const assigns = await db.guardAssignment.findAll({
        where: { tenantId, stationId: stationIdList, status: 'active' },
        attributes: ['stationId', 'guardId'],
        include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'] }],
      });
      for (const a of assigns) {
        const k = String(a.stationId);
        const u: any = a.guard || {};
        if (!guardsByStation.has(k)) guardsByStation.set(k, []);
        guardsByStation.get(k)!.push({
          id: u.id || a.guardId,
          name: u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || '—',
        });
      }
    }

    const bySite = new Map<string, any[]>();
    const loose: any[] = [];
    for (const st of stations) {
      const plain = st.get ? st.get({ plain: true }) : st;
      plain.guards = guardsByStation.get(String(plain.id)) || [];
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
        name: s.companyName,
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
