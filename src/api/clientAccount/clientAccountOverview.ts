import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { Op } from 'sequelize';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;

    if (!tenantId || !clientAccountId) {
      return ApiResponseHandler.success(req, res, {
        postSitesCount: 0,
        assignedCount: 0,
        onsiteCount: 0,
        toursLast7Days: 0,
        tasksLast7Days: 0,
        incidentsLast7Days: 0,
        hoursLoggedSeconds: 0,
      });
    }

    try {
      const sequelize = req.database.sequelize;

      const BusinessInfo = req.database.businessInfo;
      const Station = req.database.station;
      const Shift = req.database.shift;
      const SiteTourTag = req.database.siteTourTag;
      const SiteTour = req.database.siteTour;
      const Task = req.database.task;
      const Incident = req.database.incident;

      // find postSites for this client
      const postSites = await BusinessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id'] });
      const postSiteIds = (postSites || []).map((p: any) => p.id).filter(Boolean);

      const postSitesCount = postSiteIds.length;

      // find stations under these postSites
      const stations = postSiteIds.length ? await Station.findAll({ where: { postSiteId: postSiteIds, tenantId }, attributes: ['id'] }) : [];
      const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);

      // Assigned guards — derive from shifts for these postSites
      let assignedCount = 0;
      try {
        const orClauses: any[] = [];
        if (postSiteIds.length) orClauses.push({ postSiteId: postSiteIds });
        if (stationIds.length) orClauses.push({ stationId: stationIds });

        const tenantFilter: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};
        const shiftsForSites = await Shift.findAll({ where: { [Op.and]: [tenantFilter, { [Op.or]: orClauses }] }, attributes: ['tenantUserId', 'guardId', 'id', 'stationId', 'postSiteId'] });

        const unique = new Set<string>();
        for (const sh of (shiftsForSites || [])) {
          const plain = (sh && typeof sh.get === 'function') ? sh.get({ plain: true }) : sh;
          const key = plain && (
            plain.tenantUserId || plain.tenant_user_id || plain.guardId || plain.guard_id ||
            (plain.guard && (plain.guard.id || plain.guardId)) || plain.userId || plain.securityGuardId || null
          );
          if (key) unique.add(String(key));
        }

        assignedCount = unique.size;
      } catch (e) {
        assignedCount = 0;
      }

      // Shifts: onsite count and hours logged in last 7 days
      let onsiteCount = 0;
      let hoursLoggedSeconds = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const now = new Date();

        const orForShifts: any[] = [];
        if (postSiteIds.length) orForShifts.push({ postSiteId: postSiteIds });
        if (stationIds.length) orForShifts.push({ stationId: stationIds });

        const tenantFilter2: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};
        const shifts = orForShifts.length ? await Shift.findAll({ where: { [Op.and]: [tenantFilter2, { [Op.or]: orForShifts }] } }) : [];

        for (const sh of (shifts || [])) {
          const s = sh.startTime ? new Date(sh.startTime) : null;
          const e = sh.endTime ? new Date(sh.endTime) : null;
          if (s && e) {
            if (s <= now && now <= e) onsiteCount += 1;
            const overlapStart = s > sevenDaysAgo ? s : sevenDaysAgo;
            const overlapEnd = e < now ? e : now;
            if (overlapEnd > overlapStart) {
              hoursLoggedSeconds += Math.floor((overlapEnd.getTime() - overlapStart.getTime()) / 1000);
            }
          }
        }
      } catch (e) {
        onsiteCount = 0;
        hoursLoggedSeconds = 0;
      }

      // Tours completed in last 7 days
      let toursLast7Days = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        let tagsDirect = 0;
        if (postSiteIds.length) {
          tagsDirect = await SiteTourTag.count({ where: { postSiteId: postSiteIds, tenantId, createdAt: { [Op.gte]: sevenDaysAgo } } });
        }

        let tagsByTour = 0;
        if (postSiteIds.length) {
          const tours = await SiteTour.findAll({ where: { postSiteId: postSiteIds, tenantId }, attributes: ['id'] });
          const tourIds = (tours || []).map((t: any) => t.id).filter(Boolean);
          if (tourIds.length) {
            tagsByTour = await SiteTourTag.count({ where: { siteTourId: tourIds, tenantId, createdAt: { [Op.gte]: sevenDaysAgo } } });
          }
        }

        toursLast7Days = Number(tagsDirect || 0) + Number(tagsByTour || 0);
      } catch (e) {
        toursLast7Days = 0;
      }

      // Tasks completed in last 7 days
      let tasksLast7Days = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (stationIds.length) {
          const tasks = await Task.findAll({ where: { taskBelongsToStationId: stationIds, dateCompletedTask: { [Op.gte]: sevenDaysAgo }, tenantId } });
          tasksLast7Days = (tasks || []).length;
        } else {
          tasksLast7Days = 0;
        }
      } catch (e) {
        tasksLast7Days = 0;
      }

      // Incidents in last 7 days — consider postSiteId OR siteId (no stationId)
      let incidentsLast7Days = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const linkClauses: any[] = [];
        if (postSiteIds.length) linkClauses.push({ postSiteId: postSiteIds });
        if (postSiteIds.length) linkClauses.push({ siteId: postSiteIds });

        const dateClauses = [
          { createdAt: { [Op.gte]: sevenDaysAgo } },
          { incidentAt: { [Op.gte]: sevenDaysAgo } },
          { date: { [Op.gte]: sevenDaysAgo } },
          { dateTime: { [Op.gte]: sevenDaysAgo } },
        ];

        const tenantFilterIncident: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};

        const rows = (linkClauses.length) ? await Incident.findAll({ where: { [Op.and]: [ tenantFilterIncident, { [Op.or]: linkClauses }, { [Op.or]: dateClauses } ] } }) : [];
        incidentsLast7Days = (rows || []).length;
      } catch (e) {
        incidentsLast7Days = 0;
      }

      return ApiResponseHandler.success(req, res, {
        postSitesCount: Number(postSitesCount || 0),
        assignedCount: Number(assignedCount || 0),
        onsiteCount: Number(onsiteCount || 0),
        toursLast7Days: Number(toursLast7Days || 0),
        tasksLast7Days: Number(tasksLast7Days || 0),
        incidentsLast7Days: Number(incidentsLast7Days || 0),
        hoursLoggedSeconds: Number(hoursLoggedSeconds || 0),
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
