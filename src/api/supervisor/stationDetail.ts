import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Full station detail for the supervisor "Station Details" screen: hero
 * (photo/status/address/tags/risk), KPI strip (guards/patrol/incidents/tasks),
 * geofence + checkpoints for the map, assigned-guard cards, station info
 * (client/site-type/contact/hours), and tab counts. Every section is defensively
 * guarded. Read-only, gated `supervisorMe`.
 */

function toNum(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Human label for a post-site security service type (mirrors CRM serviceTypes). */
const SERVICE_TYPE_LABELS: Record<string, string> = {
  manned: 'Vigilancia con vigilantes',
  alarm: 'Alarma y respuesta',
  cctv: 'Videovigilancia',
  patrol: 'Patrulla móvil',
  custody: 'Custodia y escolta',
};
function serviceTypeLabel(v: any): string | null {
  if (!v) return null;
  return SERVICE_TYPE_LABELS[String(v).toLowerCase()] || String(v);
}

/** Best-effort display time zone from the client's country + longitude. */
function deriveTimeZone(country: any, lng: number | null): string | null {
  const c = String(country || '').trim().toLowerCase();
  if (['united states', 'usa', 'us', 'estados unidos', 'ee.uu.'].includes(c)) {
    if (lng == null) return 'Estados Unidos';
    if (lng > -87.5) return 'Eastern Time (GMT-5)';
    if (lng > -100) return 'Central Time (GMT-6)';
    if (lng > -115) return 'Mountain Time (GMT-7)';
    return 'Pacific Time (GMT-8)';
  }
  const named: Record<string, string> = {
    ecuador: 'America/Guayaquil (GMT-5)',
    colombia: 'America/Bogotá (GMT-5)',
    peru: 'America/Lima (GMT-5)',
    perú: 'America/Lima (GMT-5)',
    mexico: 'America/Mexico_City (GMT-6)',
    méxico: 'America/Mexico_City (GMT-6)',
    chile: 'America/Santiago (GMT-4)',
    argentina: 'America/Argentina (GMT-3)',
    spain: 'Europe/Madrid (GMT+1)',
    'españa': 'Europe/Madrid (GMT+1)',
  };
  if (named[c]) return named[c];
  if (lng != null) {
    const off = Math.round(lng / 15);
    return `GMT${off >= 0 ? '+' : ''}${off}`;
  }
  return null;
}

/** Parse a categoryIds JSON column into a string[] of ids. */
function parseIds(v: any): string[] {
  let raw = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return raw ? [String(raw)] : [];
    }
  }
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function fileUrl(files: any): Promise<any> {
  try {
    if (Array.isArray(files) && files.length) {
      const filled = await FileRepository.fillDownloadUrl(files);
      return filled[0] || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** GET /tenant/:tenantId/supervisor/me/stations/:stationId */
export const getStationDetail = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;
    const stationId = String(req.params.stationId);

    // ── Station ───────────────────────────────────────────────────────────
    const station = await db.station.findOne({
      where: { id: stationId, tenantId },
      attributes: [
        'id', 'stationName', 'nickname', 'latitud', 'longitud', 'postSiteId',
        'startingTimeInDay', 'finishTimeInDay', 'stationSchedule', 'scheduleType',
        'geofencePolygon', 'geofenceRadius',
      ],
    });
    if (!station) return ApiResponseHandler.success(req, res, { station: null });

    // ── Post site + client (address, photo, site type, contact) ──────────
    let post: any = null;
    let client: any = null;
    if (station.postSiteId) {
      post = await db.businessInfo.findByPk(station.postSiteId, {
        attributes: ['id', 'companyName', 'address', 'city', 'country', 'serviceType', 'categoryIds', 'contactPhone', 'contactEmail', 'clientAccountId'],
        include: [
          { model: db.file, as: 'logo', required: false },
          {
            model: db.clientAccount,
            as: 'clientAccount',
            required: false,
            attributes: ['id', 'name', 'lastName', 'commercialName', 'phoneNumber', 'email', 'country', 'city', 'latitude', 'longitude', 'categoryIds'],
            include: [
              { model: db.file, as: 'placePictureUrl', required: false },
              { model: db.file, as: 'logoUrl', required: false },
            ],
          },
        ],
      });
      client = post ? post.clientAccount : null;
    }

    const photo =
      (client && (await fileUrl(client.placePictureUrl))) ||
      (post && (await fileUrl(post.logo))) ||
      (client && (await fileUrl(client.logoUrl))) ||
      null;

    // ── Assigned guards (from the schedule) + on-duty state ──────────────
    const assignedUserIds = new Set<string>();
    try {
      const sched = await db.shift.findAll({
        where: { tenantId, stationId },
        attributes: ['guardId'],
        group: ['guardId'],
        limit: 5000,
      });
      sched.forEach((r: any) => r.guardId && assignedUserIds.add(String(r.guardId)));
    } catch {
      /* schedule optional */
    }

    // Who is on duty right now (open shift at this station, via shift or postSite).
    const openShifts = await db.guardShift.findAll({
      where: { tenantId, punchOutTime: null },
      attributes: ['guardNameId', 'shiftId', 'postSiteId'],
      limit: 5000,
    });
    const onDutyShiftIds = openShifts.map((s: any) => s.shiftId).filter(Boolean);
    const shiftStationMap = new Map<string, string | null>();
    if (onDutyShiftIds.length) {
      const scheds = await db.shift.findAll({
        where: { tenantId, id: { [Op.in]: onDutyShiftIds } },
        attributes: ['id', 'stationId'],
      });
      scheds.forEach((s: any) => shiftStationMap.set(String(s.id), s.stationId ? String(s.stationId) : null));
    }
    const onDutyGuardIds = new Set<string>(); // securityGuard.id
    for (const sh of openShifts) {
      let stId: string | null = sh.shiftId ? shiftStationMap.get(String(sh.shiftId)) ?? null : null;
      if (!stId && sh.postSiteId && String(sh.postSiteId) === String(station.postSiteId)) stId = stationId;
      if (stId === stationId) onDutyGuardIds.add(String(sh.guardNameId));
    }

    let guards: any[] = [];
    if (assignedUserIds.size) {
      const sgs = await db.securityGuard.findAll({
        where: { tenantId, guardId: { [Op.in]: [...assignedUserIds] } },
        attributes: ['id', 'fullName', 'guardId'],
        include: [{ model: db.file, as: 'profileImage', required: false }],
        limit: 5000,
      });
      guards = await Promise.all(
        sgs.map(async (sg: any) => {
          const onDuty = onDutyGuardIds.has(String(sg.id));
          return {
            id: String(sg.id),
            name: sg.fullName,
            avatarUrl: (await fileUrl(sg.profileImage))?.downloadUrl || null,
            onDuty,
            status: onDuty ? 'patrolling' : 'off',
            location: null,
          };
        }),
      );
    }

    // ── Checkpoints (station's ronda tags) + today's patrol progress ─────
    let checkpoints: any[] = [];
    let progress = { done: 0, total: 0, pct: 0 };
    try {
      const tags = await db.siteTourTag.findAll({
        where: { tenantId, stationId },
        attributes: ['id', 'name', 'latitude', 'longitude'],
        limit: 300,
      });
      const tagIds = tags.map((t: any) => String(t.id));
      const scannedSet = new Set<string>();
      if (tagIds.length) {
        const scans = await db.tagScan.findAll({
          where: { tenantId, siteTourTagId: { [Op.in]: tagIds }, scannedAt: { [Op.gte]: startOfToday() } },
          attributes: ['siteTourTagId'],
          limit: 2000,
        });
        scans.forEach((s: any) => scannedSet.add(String(s.siteTourTagId)));
      }
      checkpoints = tags.map((t: any) => ({
        id: String(t.id),
        name: t.name,
        lat: toNum(t.latitude),
        lng: toNum(t.longitude),
        scanned: scannedSet.has(String(t.id)),
      }));
      const done = checkpoints.filter((c) => c.scanned).length;
      const total = checkpoints.length;
      progress = { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
    } catch {
      /* ronda optional */
    }

    // ── Incidents (today) + pending tasks ────────────────────────────────
    let openIncidents = 0;
    try {
      openIncidents = await db.incident.count({
        where: { tenantId, stationId, createdAt: { [Op.gte]: startOfToday() } },
      });
    } catch {
      openIncidents = 0;
    }
    let tasksPending = 0;
    try {
      tasksPending = await db.task.count({
        where: {
          tenantId,
          taskBelongsToStationId: stationId,
          status: { [Op.notIn]: ['done', 'completed', 'rejected', 'cancelled'] },
        },
      });
    } catch {
      tasksPending = 0;
    }

    // ── Derived status / risk / priority ─────────────────────────────────
    const status: 'active' | 'attention' | 'offline' =
      onDutyGuardIds.size === 0 ? 'offline' : openIncidents >= 3 ? 'attention' : 'active';
    const riskLevel = openIncidents === 0 ? 'low' : openIncidents < 3 ? 'medium' : 'high';

    // ── Geofence polygon ─────────────────────────────────────────────────
    let geofence: Array<{ lat: number; lng: number }> = [];
    try {
      const raw = station.geofencePolygon; // getter parses JSON
      if (Array.isArray(raw)) {
        geofence = raw
          .map((p: any) => ({ lat: toNum(p.lat ?? p.latitude), lng: toNum(p.lng ?? p.longitude) }))
          .filter((p) => p.lat != null && p.lng != null) as any;
      }
    } catch {
      geofence = [];
    }

    const addressParts = [post?.address, post?.city].filter(Boolean);
    const contactName = client
      ? [client.name, client.lastName].filter(Boolean).join(' ')
      : null;
    const accessHours =
      station.startingTimeInDay && station.finishTimeInDay
        ? `${station.startingTimeInDay} - ${station.finishTimeInDay}`
        : null;

    // Site type = post-site service type (labelled) → else the client/post
    // business category name.
    let siteType: string | null = serviceTypeLabel(post?.serviceType);
    if (!siteType) {
      try {
        const catIds = [...parseIds(post?.categoryIds), ...parseIds(client?.categoryIds)];
        if (catIds.length) {
          const cat = await db.category.findOne({
            where: { tenantId, id: { [Op.in]: catIds } },
            attributes: ['name'],
          });
          if (cat && cat.name) siteType = cat.name;
        }
      } catch {
        /* category optional */
      }
    }

    // Time zone derived from the client's country + longitude.
    const timeZone = deriveTimeZone(
      client?.country || post?.country,
      toNum(client?.longitude) ?? toNum(post?.longitud) ?? toNum(station.longitud),
    );

    await ApiResponseHandler.success(req, res, {
      station: {
        id: String(station.id),
        name: station.stationName,
        status,
        riskLevel,
        priority: openIncidents > 0 ? 'high' : null,
        address: addressParts.length ? addressParts.join(', ') : null,
        photo,
        serviceType: siteType,
        lat: toNum(station.latitud),
        lng: toNum(station.longitud),
        geofence,
        geofenceRadius: toNum(station.geofenceRadius),
        stats: {
          guardsAssigned: guards.length,
          patrolProgress: progress,
          openIncidents,
          tasksPending,
        },
        checkpointsTotal: checkpoints.length,
        guards,
        checkpoints,
        info: {
          client: client ? client.commercialName || client.name : null,
          siteType,
          alarmPanel: null,
          contactPerson: contactName,
          contactPhone: (client && client.phoneNumber) || post?.contactPhone || null,
          accessHours,
          timeZone,
        },
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getStationDetail;
