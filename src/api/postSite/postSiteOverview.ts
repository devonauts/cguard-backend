import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { Op } from 'sequelize';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const postSiteId = req.params.id;
    if (!tenantId || !postSiteId) {
      return ApiResponseHandler.success(req, res, {
        assignedCount: 0,
        onsiteCount: 0,
        toursLast7Days: 0,
        tasksLast7Days: 0,
        incidentsLast7Days: 0,
        hoursLoggedSeconds: 0,
      });
    }

    const sequelize = req.database.sequelize;

    // 1) Assigned guards — derive from shifts for this postSite (direct).
    // Some shifts reference the postSite via `postSiteId`, others only via station.postSiteId.
    let assignedCount = 0;
    // keep stationIds in outer scope so other sections can reuse them
    let stationIds: any[] = [];
    try {
      const Shift = req.database.shift;
      const Station = req.database.station;

      // find stations that belong to this postSite
      const stationsForAssigned = await Station.findAll({ where: { postSiteId, tenantId }, attributes: ['id'] });
      stationIds = (stationsForAssigned || []).map((s: any) => (s && s.id)).filter(Boolean);

      // build where: tenantId AND (postSiteId = postSiteId OR stationId IN stationIds)
      const orClauses: any[] = [{ postSiteId }];
      if (stationIds.length) orClauses.push({ stationId: stationIds });

      const tenantFilter: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};
      // request guardId and tenantUserId explicitly so we can dedupe correctly
      const shiftsForSite = await Shift.findAll({ where: { [Op.and]: [tenantFilter, { [Op.or]: orClauses }] }, attributes: ['tenantUserId', 'guardId', 'id', 'stationId', 'postSiteId'] });

      const unique = new Set<string>();
      for (const sh of (shiftsForSite || [])) {
        const plain = (sh && typeof sh.get === 'function') ? sh.get({ plain: true }) : sh;
        const key = plain && (
          plain.tenantUserId || plain.tenant_user_id || plain.guardId || plain.guard_id ||
          // if association was loaded it may appear under `guard` object
          (plain.guard && (plain.guard.id || plain.guardId)) || plain.userId || plain.securityGuardId || null
        );
        if (key) unique.add(String(key));
      }

      assignedCount = unique.size;
    } catch (e) {
      assignedCount = 0;
    }

    // 2) Shifts: onsite count (now between startTime and endTime), and hours logged in last 7 days
    let onsiteCount = 0;
    let hoursLoggedSeconds = 0;
    try {
      const Shift = req.database.shift;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const now = new Date();

      // include shifts that match postSiteId OR belong to stations under this postSite
      const stationFilter = stationIds && stationIds.length ? { stationId: stationIds } : null;
      const orForShifts: any[] = [{ postSiteId }];
      if (stationFilter) orForShifts.push(stationFilter);
      const tenantFilter2: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};
      const shifts = await Shift.findAll({ where: { [Op.and]: [tenantFilter2, { [Op.or]: orForShifts }] } });
      for (const sh of (shifts || [])) {
        const s = sh.startTime ? new Date(sh.startTime) : null;
        const e = sh.endTime ? new Date(sh.endTime) : null;
        if (s && e) {
          if (s <= now && now <= e) onsiteCount += 1;
          // count overlap with last 7 days window
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

    // 3) Tours completed (use siteTourTag createdAt as proxy) in last 7 days
    let toursLast7Days = 0;
    try {
      const SiteTourTag = req.database.siteTourTag;
      const SiteTour = req.database.siteTour;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // tags that explicitly reference postSiteId
      const tagsDirect = await SiteTourTag.count({ where: { postSiteId, tenantId, createdAt: { [Op.gte]: sevenDaysAgo } } });

      // tags that belong to tours under this post site
      const tours = await SiteTour.findAll({ where: { postSiteId, tenantId }, attributes: ['id'] });
      const tourIds = (tours || []).map((t: any) => t.id).filter(Boolean);
      let tagsByTour = 0;
      if (tourIds.length) {
        tagsByTour = await SiteTourTag.count({ where: { siteTourId: tourIds, tenantId, createdAt: { [Op.gte]: sevenDaysAgo } } });
      }

      toursLast7Days = Number(tagsDirect || 0) + Number(tagsByTour || 0);
    } catch (e) {
      toursLast7Days = 0;
    }

    // 4) Tasks completed in last 7 days (task.dateCompletedTask or task.dateToDoTheTask + wasItDone)
    let tasksLast7Days = 0;
    try {
      const Task = req.database.task;
      const Station = req.database.station;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // find stations for this postSite
      const stationsForTasks = await Station.findAll({ where: { postSiteId, tenantId }, attributes: ['id'] });
      const stationIdsForTasks = (stationsForTasks || []).map((s: any) => s.id).filter(Boolean);
      if (stationIdsForTasks.length) {
        const tasks = await Task.findAll({ where: { taskBelongsToStationId: stationIdsForTasks, dateCompletedTask: { [Op.gte]: sevenDaysAgo }, tenantId } });
        tasksLast7Days = (tasks || []).length;
      } else {
        tasksLast7Days = 0;
      }
    } catch (e) {
      tasksLast7Days = 0;
    }

    // 5) Incidents in last 7 days — consider only postSiteId or siteId (no stationId)
    let incidentsLast7Days = 0;
    try {
      const Incident = req.database.incident;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // link clauses: postSiteId OR siteId only
      const linkClauses: any[] = [{ postSiteId }, { siteId: postSiteId }];

      // date clauses to accept several fields as the incident timestamp
      const dateClauses = [
        { createdAt: { [Op.gte]: sevenDaysAgo } },
        { incidentAt: { [Op.gte]: sevenDaysAgo } },
        { date: { [Op.gte]: sevenDaysAgo } },
        { dateTime: { [Op.gte]: sevenDaysAgo } },
      ];

      const tenantFilterIncident: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};

      const rows = await Incident.findAll({ where: { [Op.and]: [ tenantFilterIncident, { [Op.or]: linkClauses }, { [Op.or]: dateClauses } ] } });
      incidentsLast7Days = (rows || []).length;
    } catch (e) {
      incidentsLast7Days = 0;
    }

    await ApiResponseHandler.success(req, res, {
      assignedCount: Number(assignedCount || 0),
      onsiteCount: Number(onsiteCount || 0),
      toursLast7Days: Number(toursLast7Days || 0),
      tasksLast7Days: Number(tasksLast7Days || 0),
      incidentsLast7Days: Number(incidentsLast7Days || 0),
      hoursLoggedSeconds: Number(hoursLoggedSeconds || 0),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
