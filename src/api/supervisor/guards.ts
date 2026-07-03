import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Guard roster + live telemetry for the supervisor "Guards" screen.
 *
 * Returns every tenant guard with a live status and whatever real signals we can
 * assemble from an OPEN attendance shift (punched in, not out):
 *   • status  — on_duty (has an open shift) / offline (flagged on-duty but no
 *               open shift → not reporting) / off_duty (everyone else).
 *   • shiftStartAt, battery, lat/lng, lastUpdateAt  — from the open shift.
 *   • rating  — average of the guard's customer ratings.
 *   • station/location, phone, avatar (profile photo download URL).
 * Signals with no source (patrol progress, live signal strength) are left null;
 * the app renders "—" for them. Read-only, gated `supervisorMe`.
 */

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** GET /tenant/:tenantId/supervisor/me/guards */
export const getGuards = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;

    // 1) Roster (identity + on-duty flag + profile photo + linked user).
    const guards = await db.securityGuard.findAll({
      where: { tenantId },
      attributes: ['id', 'fullName', 'isOnDuty', 'guardId'],
      include: [
        {
          model: db.user,
          as: 'guard',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNumber'],
          required: false,
        },
        { model: db.file, as: 'profileImage', required: false },
      ],
      order: [['fullName', 'ASC']],
      limit: 2000,
    });

    // 2) Open attendance shifts, newest first → one per guard.
    const openShifts = await db.guardShift.findAll({
      where: { tenantId, punchOutTime: null },
      attributes: [
        'id',
        'guardNameId',
        'punchInTime',
        'punchInBattery',
        'punchInLatitude',
        'punchInLongitude',
        'shiftId',
        'postSiteId',
      ],
      order: [['punchInTime', 'DESC']],
      limit: 5000,
    });
    const openByGuard = new Map<string, any>();
    openShifts.forEach((s: any) => {
      const k = String(s.guardNameId);
      if (!openByGuard.has(k)) openByGuard.set(k, s);
    });

    // 3) Station lookups (by id + by postSite) to resolve each shift's location.
    const stations = await db.station.findAll({
      where: { tenantId },
      attributes: ['id', 'stationName', 'postSiteId'],
      limit: 2000,
    });
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));
    const stationByPost = new Map<string, any>();
    stations.forEach((s: any) => {
      if (s.postSiteId) stationByPost.set(String(s.postSiteId), s);
    });

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

    // 4) Average rating per guard.
    const ratingRows = await db.guardRating.findAll({
      where: { tenantId },
      attributes: [
        'guardId',
        [db.Sequelize.fn('AVG', db.Sequelize.col('rating')), 'avg'],
      ],
      group: ['guardId'],
    });
    const ratingByGuard = new Map<string, number>();
    ratingRows.forEach((r: any) => {
      const avg = toNum(r.get('avg'));
      if (avg != null) ratingByGuard.set(String(r.guardId), Math.round(avg * 10) / 10);
    });

    // 5) Assemble.
    const rows = await Promise.all(
      guards.map(async (g: any) => {
        const id = String(g.id);
        const open = openByGuard.get(id) || null;
        const status: 'on_duty' | 'off_duty' | 'offline' = open
          ? 'on_duty'
          : g.isOnDuty
          ? 'offline'
          : 'off_duty';

        let stationName: string | null = null;
        if (open) {
          const stId = open.shiftId ? stationIdByShift.get(String(open.shiftId)) : null;
          const st =
            (stId && stationById.get(stId)) ||
            (open.postSiteId && stationByPost.get(String(open.postSiteId))) ||
            null;
          stationName = st ? st.stationName : null;
        }

        // Profile photo → token/public download URL.
        let avatar: any = null;
        try {
          if (Array.isArray(g.profileImage) && g.profileImage.length) {
            const filled = await FileRepository.fillDownloadUrl(g.profileImage);
            avatar = filled[0] || null;
          }
        } catch {
          avatar = null;
        }

        const u = g.guard || null;

        return {
          id,
          name: g.fullName || (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '') || '—',
          userId: g.guardId || (u ? u.id : null),
          status,
          stationName,
          shiftStartAt: open ? open.punchInTime : null,
          lastUpdateAt: open ? open.punchInTime : null,
          battery: open ? (toNum(open.punchInBattery) ?? null) : null,
          lat: open ? toNum(open.punchInLatitude) : null,
          lng: open ? toNum(open.punchInLongitude) : null,
          rating: ratingByGuard.get(id) ?? null,
          patrolProgress: null as number | null,
          phone: u ? u.phoneNumber || null : null,
          avatar,
        };
      }),
    );

    const summary = {
      all: rows.length,
      onDuty: rows.filter((r) => r.status === 'on_duty').length,
      offDuty: rows.filter((r) => r.status === 'off_duty').length,
      offline: rows.filter((r) => r.status === 'offline').length,
    };

    await ApiResponseHandler.success(req, res, { guards: rows, summary });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getGuards;
