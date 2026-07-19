import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import { Op } from 'sequelize';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    // A customer may only read overview metrics for their OWN client.
    await assertClientAccess(req, req.params.id);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;

    if (!tenantId || !clientAccountId) {
      return ApiResponseHandler.success(req, res, {
        postSitesCount: 0,
        stationsCount: 0,
        projectsCount: 0,
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

      // find postSites for this client. Scope = ALL sites; the "Sedes activas"
      // KPI counts only active ones (an archived sede must not inflate it).
      const postSites = await BusinessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'active'] });
      const postSiteIds = (postSites || []).map((p: any) => p.id).filter(Boolean);

      const postSitesCount = (postSites || []).filter((p: any) => p.active !== false).length;

      // Stations under these postSites OR linked directly to the client
      // (stationOriginId) — same scope as operation/personnel/incidents-board,
      // so the header no longer says 0 for site-less tenants.
      const stationWhere: any[] = [{ stationOriginId: clientAccountId }];
      if (postSiteIds.length) stationWhere.push({ postSiteId: postSiteIds });
      const stations = await Station.findAll({ where: { tenantId, [Op.or]: stationWhere }, attributes: ['id'] });
      const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);
      const stationsCount = stationIds.length;

      // active projects for this client
      let projectsCount = 0;
      try {
        projectsCount = await req.database.clientProject.count({
          where: { clientAccountId, tenantId, deletedAt: null },
        });
      } catch {
        projectsCount = 0;
      }

      // Responsible account executive name + tenant timezone (header meta).
      let accountExecutiveName: string | null = null;
      let tenantTimezone: string | null = null;
      try {
        const ca = await req.database.clientAccount.findByPk(clientAccountId, { attributes: ['accountExecutiveId'] });
        if (ca?.accountExecutiveId) {
          const u = await req.database.user.findByPk(ca.accountExecutiveId, { attributes: ['fullName', 'firstName', 'lastName', 'email'] });
          if (u) accountExecutiveName = u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || null;
        }
        const tnt = await req.database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
        tenantTimezone = (tnt && tnt.timezone) || null;
      } catch { /* non-fatal */ }

      // Assigned guards — guardAssignment (single source of truth; the old
      // ALL-TIME shift scan inflated the KPI with guards unassigned months ago).
      let assignedCount = 0;
      try {
        if (stationIds.length) {
          const assigns = await req.database.guardAssignment.findAll({
            where: { tenantId, stationId: stationIds, status: 'active' },
            attributes: ['guardId'],
          });
          assignedCount = new Set((assigns || []).map((a: any) => String(a.guardId))).size;
        }
      } catch (e) {
        assignedCount = 0;
      }

      // "En turno ahora" = guards actually PUNCHED IN (open guardShift), the
      // same definition coverage/personnel use — not scheduled shifts.
      let onsiteCount = 0;
      try {
        const orOpen: any[] = [];
        if (stationIds.length) orOpen.push({ stationNameId: stationIds });
        if (postSiteIds.length) orOpen.push({ postSiteId: postSiteIds });
        if (orOpen.length) {
          const open = await req.database.guardShift.findAll({
            where: { tenantId, punchOutTime: null, [Op.or]: orOpen },
            attributes: ['guardNameId'],
          });
          onsiteCount = new Set((open || []).map((g: any) => String(g.guardNameId))).size;
        }
      } catch (e) {
        onsiteCount = 0;
      }

      // Hours WORKED (attendance) in the last 7 days — punch-in/out overlap,
      // not scheduled shift windows.
      let hoursLoggedSeconds = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const now = new Date();
        const orAtt: any[] = [];
        if (stationIds.length) orAtt.push({ stationNameId: stationIds });
        if (postSiteIds.length) orAtt.push({ postSiteId: postSiteIds });
        if (orAtt.length) {
          const punches = await req.database.guardShift.findAll({
            where: { tenantId, punchInTime: { [Op.gte]: new Date(sevenDaysAgo.getTime() - 24 * 3600000) }, [Op.or]: orAtt },
            attributes: ['punchInTime', 'punchOutTime'],
          });
          for (const p of punches || []) {
            const s = p.punchInTime ? new Date(p.punchInTime) : null;
            const e = p.punchOutTime ? new Date(p.punchOutTime) : now; // still open → count until now
            if (!s) continue;
            const overlapStart = s > sevenDaysAgo ? s : sevenDaysAgo;
            const overlapEnd = e < now ? e : now;
            if (overlapEnd > overlapStart) hoursLoggedSeconds += Math.floor((overlapEnd.getTime() - overlapStart.getTime()) / 1000);
          }
        }
      } catch (e) {
        hoursLoggedSeconds = 0;
      }

      // Rondas (7 días) = real checkpoint SCANS (tagScan), not QR definitions.
      let toursLast7Days = 0;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (stationIds.length) {
          toursLast7Days = await req.database.tagScan.count({
            where: { tenantId, stationId: stationIds, scannedAt: { [Op.gte]: sevenDaysAgo } },
          });
        }
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

      // Incidents in last 7 days — postSiteId OR siteId OR stationId links,
      // strict tenant scope (no more tenantId:null leakage). Also aggregate
      // per-sede counts for the "Estado de sedes" panel (the frontend used to
      // count inside the last 8 rows matched by NAME).
      let incidentsLast7Days = 0;
      const incidentsBySite: Record<string, number> = {};
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const linkClauses: any[] = [];
        if (postSiteIds.length) linkClauses.push({ postSiteId: postSiteIds });
        if (postSiteIds.length) linkClauses.push({ siteId: postSiteIds });
        if (stationIds.length) linkClauses.push({ stationId: stationIds });

        const dateClauses = [
          { createdAt: { [Op.gte]: sevenDaysAgo } },
          { incidentAt: { [Op.gte]: sevenDaysAgo } },
          { date: { [Op.gte]: sevenDaysAgo } },
          { dateTime: { [Op.gte]: sevenDaysAgo } },
        ];

        const rows = (linkClauses.length)
          ? await Incident.findAll({
              where: { [Op.and]: [{ tenantId }, { [Op.or]: linkClauses }, { [Op.or]: dateClauses }] },
              attributes: ['id', 'postSiteId', 'siteId', 'stationId'],
            })
          : [];
        incidentsLast7Days = (rows || []).length;

        // Attribute each incident to a sede: direct link, else via its station.
        const stationSite = new Map<string, string>();
        if (stationIds.length) {
          const stRows = await Station.findAll({ where: { id: stationIds, tenantId }, attributes: ['id', 'postSiteId'] });
          for (const s of stRows || []) if (s.postSiteId) stationSite.set(String(s.id), String(s.postSiteId));
        }
        for (const r of rows || []) {
          const sid = r.postSiteId || r.siteId || (r.stationId ? stationSite.get(String(r.stationId)) : null);
          if (sid) incidentsBySite[String(sid)] = (incidentsBySite[String(sid)] || 0) + 1;
        }
      } catch (e) {
        incidentsLast7Days = 0;
      }

      return ApiResponseHandler.success(req, res, {
        incidentsBySite,
        postSitesCount: Number(postSitesCount || 0),
        stationsCount: Number(stationsCount || 0),
        projectsCount: Number(projectsCount || 0),
        assignedCount: Number(assignedCount || 0),
        onsiteCount: Number(onsiteCount || 0),
        toursLast7Days: Number(toursLast7Days || 0),
        tasksLast7Days: Number(tasksLast7Days || 0),
        incidentsLast7Days: Number(incidentsLast7Days || 0),
        hoursLoggedSeconds: Number(hoursLoggedSeconds || 0),
        accountExecutiveName,
        tenantTimezone,
      });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
