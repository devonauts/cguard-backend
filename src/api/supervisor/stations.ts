import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Station monitor for the supervisor dashboard map.
 *
 * Classifies every tenant station into one of three live states so the app can
 * paint colored pins + the header stat cards:
 *   • on_duty — at least one guard has an OPEN attendance shift (punched in,
 *               not yet out) at the station.
 *   • late    — nobody is punched in, but a scheduled shift is active right now
 *               (coverage is expected → the guard is late / absent).
 *   • offline — nobody is punched in and no coverage is scheduled right now.
 *
 * Read-only. Gated with `supervisorMe` like the rest of /supervisor/me/*.
 */

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** GET /tenant/:tenantId/supervisor/me/stations */
export const getStations = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;
    const now = new Date();

    // 1) All tenant stations (coords may be null → those just don't map).
    const stationRows = await db.station.findAll({
      where: { tenantId },
      attributes: ['id', 'stationName', 'nickname', 'latitud', 'longitud', 'postSiteId'],
      order: [['stationName', 'ASC']],
      limit: 2000,
    });

    // 2) Open attendance shifts (guard clocked in, not out).
    const openShifts = await db.guardShift.findAll({
      where: { tenantId, punchOutTime: null },
      attributes: ['id', 'postSiteId', 'shiftId'],
      limit: 5000,
    });

    // 2a) Resolve each open shift's station via its scheduled-shift link.
    const shiftIds = openShifts.map((s: any) => s.shiftId).filter(Boolean);
    const stationByScheduledShift = new Map<string, string | null>();
    if (shiftIds.length) {
      const scheds = await db.shift.findAll({
        where: { tenantId, id: { [Op.in]: shiftIds } },
        attributes: ['id', 'stationId'],
      });
      scheds.forEach((s: any) =>
        stationByScheduledShift.set(String(s.id), s.stationId ? String(s.stationId) : null),
      );
    }

    // 2b) Fallback link: guardShift.postSiteId → station.postSiteId.
    const stationsByPostSite = new Map<string, string[]>();
    stationRows.forEach((s: any) => {
      if (!s.postSiteId) return;
      const k = String(s.postSiteId);
      if (!stationsByPostSite.has(k)) stationsByPostSite.set(k, []);
      stationsByPostSite.get(k)!.push(String(s.id));
    });

    // 3) Count open shifts per station.
    const onDutyByStation = new Map<string, number>();
    const bump = (stId: string) =>
      onDutyByStation.set(stId, (onDutyByStation.get(stId) || 0) + 1);
    openShifts.forEach((sh: any) => {
      const viaSchedule = sh.shiftId
        ? stationByScheduledShift.get(String(sh.shiftId))
        : null;
      if (viaSchedule) {
        bump(viaSchedule);
        return;
      }
      if (sh.postSiteId) {
        (stationsByPostSite.get(String(sh.postSiteId)) || []).forEach(bump);
      }
    });

    // 4) Scheduled coverage active RIGHT NOW → late detection.
    const activeScheds = await db.shift.findAll({
      where: {
        tenantId,
        startTime: { [Op.lte]: now },
        endTime: { [Op.gte]: now },
      },
      attributes: ['stationId'],
      limit: 5000,
    });
    const scheduledNow = new Set<string>(
      activeScheds
        .map((s: any) => (s.stationId ? String(s.stationId) : null))
        .filter(Boolean) as string[],
    );

    // 4b) Address per station (from its post site) — used by the map pin popup's
    // address-based navigation.
    const postSiteIds = [
      ...new Set(stationRows.map((s: any) => s.postSiteId).filter(Boolean).map(String)),
    ];
    const addressByPost = new Map<string, string | null>();
    if (postSiteIds.length) {
      const posts = await db.businessInfo.findAll({
        where: { id: { [Op.in]: postSiteIds } },
        attributes: ['id', 'address', 'city'],
      });
      posts.forEach((p: any) => {
        const parts = [p.address, p.city].filter(Boolean);
        addressByPost.set(String(p.id), parts.length ? parts.join(', ') : null);
      });
    }

    // 5) Classify.
    const stations = stationRows.map((s: any) => {
      const id = String(s.id);
      const onDuty = onDutyByStation.get(id) || 0;
      let status: 'on_duty' | 'late' | 'offline' = 'offline';
      if (onDuty > 0) status = 'on_duty';
      else if (scheduledNow.has(id)) status = 'late';
      return {
        id,
        name: s.stationName,
        nickname: s.nickname || null,
        address: s.postSiteId ? addressByPost.get(String(s.postSiteId)) ?? null : null,
        lat: toNum(s.latitud),
        lng: toNum(s.longitud),
        guardsOnDuty: onDuty,
        status,
      };
    });

    const summary = {
      total: stations.length,
      onDuty: stations.filter((s) => s.status === 'on_duty').length,
      late: stations.filter((s) => s.status === 'late').length,
      offline: stations.filter((s) => s.status === 'offline').length,
    };

    // Only stations with coordinates can render on the map; the summary counts
    // the whole fleet so the header cards reflect every station.
    const mapped = stations.filter((s) => s.lat != null && s.lng != null);

    await ApiResponseHandler.success(req, res, {
      stations: mapped,
      summary,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getStations;
