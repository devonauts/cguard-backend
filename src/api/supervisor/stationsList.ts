import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Rich station roster for the supervisor "Stations" list screen. Each station:
 * identity + address + customer logo (from its postSite), a live status
 * (active / attention / offline), the guards currently on duty there (avatars),
 * today's incident count, and pending-task count. Read-only, gated
 * `supervisorMe`.
 *
 * Status heuristic:
 *   • offline   — nobody on duty (no open attendance shift at the station).
 *   • attention — on duty, but ≥ ATTENTION_INCIDENTS incidents logged today.
 *   • active    — on duty, few/no incidents.
 */

const ATTENTION_INCIDENTS = 3;

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** GET /tenant/:tenantId/supervisor/me/stations/list */
export const getStationsList = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;

    // 1) Stations.
    const stations = await db.station.findAll({
      where: { tenantId },
      attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
      order: [['stationName', 'ASC']],
      limit: 2000,
    });
    const stationIds = stations.map((s: any) => String(s.id));

    // 2) Post sites (address + logo).
    const postSiteIds = [
      ...new Set(stations.map((s: any) => s.postSiteId).filter(Boolean).map(String)),
    ];
    const postSiteById = new Map<string, any>();
    if (postSiteIds.length) {
      const posts = await db.businessInfo.findAll({
        where: { id: { [Op.in]: postSiteIds } },
        attributes: ['id', 'companyName', 'address', 'city', 'country'],
        include: [
          { model: db.file, as: 'logo', required: false },
          // The customer logo usually lives on the client account, not the
          // post-site itself — resolve it via postSite → clientAccount.logoUrl.
          {
            model: db.clientAccount,
            as: 'clientAccount',
            required: false,
            attributes: ['id', 'name'],
            include: [{ model: db.file, as: 'logoUrl', required: false }],
          },
        ],
      });
      for (const p of posts) {
        let logo: any = null;
        try {
          const own = Array.isArray(p.logo) && p.logo.length ? p.logo : null;
          const client =
            p.clientAccount && Array.isArray(p.clientAccount.logoUrl) && p.clientAccount.logoUrl.length
              ? p.clientAccount.logoUrl
              : null;
          const source = own || client;
          if (source) {
            const filled = await FileRepository.fillDownloadUrl(source);
            logo = filled[0] || null;
          }
        } catch {
          logo = null;
        }
        postSiteById.set(String(p.id), {
          address: p.address || null,
          city: p.city || null,
          logo,
        });
      }
    }

    // 3) Open attendance shifts → guards on duty per station.
    const openShifts = await db.guardShift.findAll({
      where: { tenantId, punchOutTime: null },
      attributes: ['id', 'guardNameId', 'shiftId', 'postSiteId'],
      include: [
        {
          model: db.securityGuard,
          as: 'guardName',
          attributes: ['id', 'fullName'],
          required: false,
          include: [{ model: db.file, as: 'profileImage', required: false }],
        },
      ],
      // NOTE: no `order` here — combining an ordered top-level column with an
      // include + limit makes Sequelize wrap in a subquery that can't see the
      // order column. We only need the set of on-duty guards per station.
      limit: 5000,
    });

    // shiftId → stationId
    const shiftIds = openShifts.map((s: any) => s.shiftId).filter(Boolean);
    const stationIdByShift = new Map<string, string | null>();
    if (shiftIds.length) {
      const scheds = await db.shift.findAll({
        where: { tenantId, id: { [Op.in]: shiftIds } },
        attributes: ['id', 'stationId'],
      });
      scheds.forEach((s: any) =>
        stationIdByShift.set(String(s.id), s.stationId ? String(s.stationId) : null),
      );
    }
    // postSiteId → stationId
    const stationByPost = new Map<string, string>();
    stations.forEach((s: any) => {
      if (s.postSiteId) stationByPost.set(String(s.postSiteId), String(s.id));
    });

    const guardsByStation = new Map<string, any[]>();
    const seenGuardPerStation = new Set<string>();
    for (const sh of openShifts) {
      let stId: string | null = sh.shiftId ? stationIdByShift.get(String(sh.shiftId)) ?? null : null;
      if (!stId && sh.postSiteId) stId = stationByPost.get(String(sh.postSiteId)) ?? null;
      if (!stId) continue;
      const g = sh.guardName;
      if (!g) continue;
      const dedupe = `${stId}:${g.id}`;
      if (seenGuardPerStation.has(dedupe)) continue;
      seenGuardPerStation.add(dedupe);
      let avatarUrl: string | null = null;
      try {
        if (Array.isArray(g.profileImage) && g.profileImage.length) {
          const filled = await FileRepository.fillDownloadUrl(g.profileImage);
          avatarUrl = (filled[0] && (filled[0] as any).downloadUrl) || null;
        }
      } catch {
        avatarUrl = null;
      }
      if (!guardsByStation.has(stId)) guardsByStation.set(stId, []);
      guardsByStation.get(stId)!.push({ id: String(g.id), name: g.fullName, avatarUrl });
    }

    // 4) Today's incidents per station.
    const incidentsByStation = new Map<string, number>();
    try {
      const incidents = await db.incident.findAll({
        where: {
          tenantId,
          stationId: { [Op.in]: stationIds.length ? stationIds : [null] },
          createdAt: { [Op.gte]: startOfToday() },
        },
        attributes: ['id', 'stationId'],
        limit: 5000,
      });
      incidents.forEach((i: any) => {
        const k = String(i.stationId);
        incidentsByStation.set(k, (incidentsByStation.get(k) || 0) + 1);
      });
    } catch {
      /* incidents optional */
    }

    // 5) Pending tasks per station.
    const tasksByStation = new Map<string, number>();
    try {
      const tasks = await db.task.findAll({
        where: {
          tenantId,
          taskBelongsToStationId: { [Op.in]: stationIds.length ? stationIds : [null] },
          status: { [Op.notIn]: ['done', 'completed', 'rejected', 'cancelled'] },
        },
        attributes: ['id', 'taskBelongsToStationId'],
        limit: 5000,
      });
      tasks.forEach((tk: any) => {
        const k = String(tk.taskBelongsToStationId);
        tasksByStation.set(k, (tasksByStation.get(k) || 0) + 1);
      });
    } catch {
      /* tasks optional */
    }

    // 6) Assemble.
    const rows = stations.map((s: any) => {
      const id = String(s.id);
      const post = s.postSiteId ? postSiteById.get(String(s.postSiteId)) : null;
      const guards = guardsByStation.get(id) || [];
      const incidentsToday = incidentsByStation.get(id) || 0;
      const tasksPending = tasksByStation.get(id) || 0;

      let status: 'active' | 'attention' | 'offline';
      if (guards.length === 0) status = 'offline';
      else if (incidentsToday >= ATTENTION_INCIDENTS) status = 'attention';
      else status = 'active';

      const addressParts = [post?.address, post?.city].filter(Boolean);

      return {
        id,
        name: s.stationName,
        address: addressParts.length ? addressParts.join(', ') : null,
        logo: post?.logo || null,
        status,
        lat: toNum(s.latitud),
        lng: toNum(s.longitud),
        guards: guards.slice(0, 6),
        guardsTotal: guards.length,
        incidentsToday,
        tasksPending,
      };
    });

    const summary = {
      all: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      attention: rows.filter((r) => r.status === 'attention').length,
      offline: rows.filter((r) => r.status === 'offline').length,
    };

    await ApiResponseHandler.success(req, res, { stations: rows, summary });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getStationsList;
