import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Full guard detail for the supervisor "Guard Details" screen: identity + live
 * telemetry, patrol progress (from the guard's ronda checkpoints + today's tag
 * scans), a checkpoint map, and an activity timeline. Every sub-section is
 * defensively wrapped so a tenant without ronda/report data still returns a
 * valid (partially-empty) payload instead of 500ing. Read-only, gated
 * `supervisorMe`.
 */

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** GET /tenant/:tenantId/supervisor/me/guards/:guardId */
export const getGuardDetail = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;
    const guardId = String(req.params.guardId);

    // ── Identity ──────────────────────────────────────────────────────────
    const guard = await db.securityGuard.findOne({
      where: { id: guardId, tenantId },
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
    });
    if (!guard) {
      return ApiResponseHandler.success(req, res, { guard: null });
    }
    const u = guard.guard || null;

    // ── Open attendance shift (live telemetry) ───────────────────────────
    const open = await db.guardShift.findOne({
      where: { tenantId, guardNameId: guardId, punchOutTime: null },
      attributes: [
        'id',
        'punchInTime',
        'punchInBattery',
        'punchInLatitude',
        'punchInLongitude',
        'liveLatitude',
        'liveLongitude',
        'liveSpeed',
        'liveHeading',
        'liveAccuracy',
        'liveBattery',
        'liveLocationAt',
        'scheduledStart',
        'scheduledEnd',
        'shiftId',
        'postSiteId',
      ],
      order: [['punchInTime', 'DESC']],
    });

    const status: 'on_duty' | 'off_duty' | 'offline' = open
      ? 'on_duty'
      : guard.isOnDuty
      ? 'offline'
      : 'off_duty';

    // ── Station name (via scheduled shift, then postSite) ────────────────
    let stationName: string | null = null;
    let stationId: string | null = null;
    if (open) {
      try {
        if (open.shiftId) {
          const sched = await db.shift.findByPk(open.shiftId, { attributes: ['stationId'] });
          if (sched && sched.stationId) stationId = String(sched.stationId);
        }
        let st = stationId
          ? await db.station.findByPk(stationId, { attributes: ['id', 'stationName'] })
          : null;
        if (!st && open.postSiteId) {
          st = await db.station.findOne({
            where: { tenantId, postSiteId: open.postSiteId },
            attributes: ['id', 'stationName'],
          });
        }
        if (st) {
          stationId = String(st.id);
          stationName = st.stationName;
        }
      } catch {
        /* station resolution best-effort */
      }
    }

    // ── Rating ───────────────────────────────────────────────────────────
    let rating: number | null = null;
    try {
      const avg = await db.guardRating.findOne({
        where: { tenantId, guardId },
        attributes: [[db.Sequelize.fn('AVG', db.Sequelize.col('rating')), 'avg']],
        raw: true,
      });
      rating = avg ? toNum((avg as any).avg) : null;
      if (rating != null) rating = Math.round(rating * 10) / 10;
    } catch {
      rating = null;
    }

    // ── Avatar ───────────────────────────────────────────────────────────
    let avatar: any = null;
    try {
      if (Array.isArray(guard.profileImage) && guard.profileImage.length) {
        const filled = await FileRepository.fillDownloadUrl(guard.profileImage);
        avatar = filled[0] || null;
      }
    } catch {
      avatar = null;
    }

    // Prefer live telemetry (pinged while on duty); fall back to the clock-in snapshot.
    const guardLat = open ? (toNum(open.liveLatitude) ?? toNum(open.punchInLatitude)) : null;
    const guardLng = open ? (toNum(open.liveLongitude) ?? toNum(open.punchInLongitude)) : null;

    // ── Patrol: checkpoints + today's scans ──────────────────────────────
    let checkpoints: any[] = [];
    let progress = { done: 0, total: 0, pct: 0 };
    let lastCheckpoint: any = null;
    let nextCheckpoint: any = null;
    const activity: any[] = [];

    try {
      const tours = await db.siteTour.findAll({
        where: { tenantId, securityGuardId: guardId, active: true },
        attributes: ['id'],
        limit: 50,
      });
      const tourIds = tours.map((tr: any) => tr.id);

      let tags: any[] = [];
      if (tourIds.length) {
        tags = await db.siteTourTag.findAll({
          where: { tenantId, siteTourId: { [Op.in]: tourIds } },
          attributes: ['id', 'name', 'location', 'latitude', 'longitude'],
          order: [['createdAt', 'ASC']],
          limit: 200,
        });
      }

      // Today's scans by this guard.
      const scans = await db.tagScan.findAll({
        where: {
          tenantId,
          securityGuardId: guardId,
          scannedAt: { [Op.gte]: startOfToday() },
        },
        attributes: ['id', 'siteTourTagId', 'scannedAt', 'scannedData'],
        order: [['scannedAt', 'DESC']],
        limit: 200,
      });

      const scannedByTag = new Map<string, any>();
      scans.forEach((s: any) => {
        const k = String(s.siteTourTagId);
        // keep the most recent scan per tag (scans are DESC)
        if (!scannedByTag.has(k)) scannedByTag.set(k, s);
      });

      checkpoints = tags.map((tag: any) => {
        const scan = scannedByTag.get(String(tag.id)) || null;
        return {
          id: String(tag.id),
          name: tag.name,
          location: tag.location || null,
          lat: toNum(tag.latitude),
          lng: toNum(tag.longitude),
          scanned: !!scan,
          scannedAt: scan ? scan.scannedAt : null,
        };
      });

      const doneCount = checkpoints.filter((c) => c.scanned).length;
      const total = checkpoints.length;
      progress = {
        done: doneCount,
        total,
        pct: total ? Math.round((doneCount / total) * 100) : 0,
      };

      // Last checkpoint = most recent scan overall.
      if (scans.length) {
        const last = scans[0];
        const tag = tags.find((tg: any) => String(tg.id) === String(last.siteTourTagId));
        lastCheckpoint = {
          name: tag ? tag.name : null,
          at: last.scannedAt,
        };
      }

      // Next checkpoint = first unscanned tag; distance from the guard.
      const nextTag = checkpoints.find((c) => !c.scanned);
      if (nextTag) {
        let distanceM: number | null = null;
        if (guardLat != null && guardLng != null && nextTag.lat != null && nextTag.lng != null) {
          distanceM = Math.round(haversine(guardLat, guardLng, nextTag.lat, nextTag.lng));
        }
        nextCheckpoint = { name: nextTag.name, distanceM };
      }

      // Activity: scans → "Checkpoint Scanned".
      scans.slice(0, 15).forEach((s: any) => {
        const tag = tags.find((tg: any) => String(tg.id) === String(s.siteTourTagId));
        let method: string | null = null;
        try {
          const d = typeof s.scannedData === 'string' ? JSON.parse(s.scannedData) : s.scannedData;
          method = d && (d.method || d.type) ? String(d.method || d.type) : null;
        } catch {
          method = null;
        }
        activity.push({
          type: 'checkpoint',
          title: 'checkpointScanned',
          subtitle: tag ? tag.name : null,
          method,
          at: s.scannedAt,
        });
      });
    } catch {
      /* ronda data unavailable — leave patrol section empty */
    }

    // Patrol started event (from the open shift punch-in).
    if (open && open.punchInTime) {
      activity.push({
        type: 'patrol_started',
        title: 'patrolStarted',
        subtitle: stationName,
        at: open.punchInTime,
      });
    }
    activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // ── Tasks / Reports counts ───────────────────────────────────────────
    let reportsCount = 0;
    let tasksCount = 0;
    try {
      if (u && u.id) {
        reportsCount = await db.report.count({ where: { tenantId, createdById: u.id } });
      }
    } catch {
      reportsCount = 0;
    }
    try {
      if (stationId) {
        tasksCount = await db.task.count({
          where: { tenantId, taskBelongsToStationId: stationId },
        });
      }
    } catch {
      tasksCount = 0;
    }

    await ApiResponseHandler.success(req, res, {
      guard: {
        id: String(guard.id),
        name: guard.fullName || '—',
        userId: guard.guardId || (u ? u.id : null),
        status,
        stationName,
        shiftStartAt: open ? open.punchInTime : null,
        scheduledStart: open ? open.scheduledStart : null,
        scheduledEnd: open ? open.scheduledEnd : null,
        lastUpdateAt: open ? (open.liveLocationAt || open.punchInTime) : null,
        battery: open ? (toNum(open.liveBattery) ?? toNum(open.punchInBattery)) : null,
        lat: guardLat,
        lng: guardLng,
        speed: open ? toNum(open.liveSpeed) : null,
        heading: open ? toNum(open.liveHeading) : null,
        accuracy: open ? toNum(open.liveAccuracy) : null,
        rating,
        phone: u ? u.phoneNumber || null : null,
        avatar,
        progress,
        lastCheckpoint,
        nextCheckpoint,
        checkpoints,
        activity: activity.slice(0, 20),
        reportsCount,
        tasksCount,
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getGuardDetail;
