import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Forward work schedule ("Horario") for ONE security guard. Mirrors the client
 * schedule grid but scoped to the guard's own active assignments: rows = each
 * station/position the guard is assigned to, columns = days, each cell =
 * day/night/rest computed from the station rotation + the assignment platoon
 * offset (same engine as Programador › Horario).
 *
 *   GET /tenant/:tenantId/security-guard/:id/schedule?startDate=&endDate=
 *
 * :id may be the securityGuard.id (PK) or the guard's user id. Gated by
 * userRead (mirrors /security-guard/:id/assignments).
 */

const ROTATION_EPOCH = Date.UTC(2024, 0, 1);
const dseOf = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ROTATION_EPOCH) / 86400000);
const rotationStatus = (dse: number, platoonOffset: number, dayShifts: number, nightShifts: number, restDays: number): 'day' | 'night' | 'rest' => {
  const cycle = Math.max(1, dayShifts + nightShifts + restDays);
  const a = (((dse - platoonOffset) % cycle) + cycle) % cycle;
  if (a < dayShifts) return 'day';
  if (a < dayShifts + nightShifts) return 'night';
  return 'rest';
};
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const parseYmd = (s: any, fb: Date) => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  return fb;
};

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const incomingId = req.params.id;
    const now = new Date();

    // Resolve incoming id → securityGuard + user id.
    let sg: any = await db.securityGuard.findOne({ where: { id: incomingId, tenantId }, attributes: ['id', 'guardId', 'fullName'] });
    if (!sg) sg = await db.securityGuard.findOne({ where: { guardId: incomingId, tenantId }, attributes: ['id', 'guardId', 'fullName'] });
    const guardUserId = sg?.guardId || incomingId;

    // Date window (default: today .. +13 days), capped at 31 days.
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = parseYmd(req.query.startDate, todayUtc);
    let end = parseYmd(req.query.endDate, new Date(start.getTime() + 13 * 86400000));
    if (end < start) end = new Date(start.getTime() + 13 * 86400000);
    if ((end.getTime() - start.getTime()) / 86400000 > 31) end = new Date(start.getTime() + 31 * 86400000);
    const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const days: any[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const d = new Date(t);
      days.push({ date: ymd(d), dow: DOW[d.getUTCDay()], day: d.getUTCDate(), isToday: ymd(d) === ymd(todayUtc), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 });
    }

    const empty = () => ApiResponseHandler.success(req, res, {
      guardId: sg?.id ? String(sg.id) : null, guardUserId: guardUserId ? String(guardUserId) : null,
      startDate: ymd(start), endDate: ymd(end), days, rows: [], updatedAt: now.toISOString(),
    });
    if (!guardUserId) return empty();

    // The guard's active assignments (station + position).
    const assigns = await db.guardAssignment.findAll({
      where: { tenantId, guardId: guardUserId, status: 'active' },
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'platoonOffset', 'isRelief', 'startDate'],
    }).catch(() => []);
    if (!assigns.length) return empty();

    const stationIds = Array.from(new Set(assigns.map((a: any) => String(a.stationId)).filter(Boolean)));
    const positionIds = Array.from(new Set(assigns.map((a: any) => a.positionId ? String(a.positionId) : null).filter(Boolean)));

    const stationRows = await db.station.findAll({
      where: { id: stationIds, tenantId },
      attributes: ['id', 'stationName', 'postSiteId', 'scheduleType', 'rotationStyleId'],
    }).catch(() => []);
    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), s]));

    // Resolve sede + client names for context.
    const postSiteIds = Array.from(new Set(stationRows.map((s: any) => s.postSiteId ? String(s.postSiteId) : null).filter(Boolean)));
    const siteRows = postSiteIds.length ? await db.businessInfo.findAll({ where: { id: postSiteIds, tenantId }, attributes: ['id', 'companyName', 'clientAccountId'] }).catch(() => []) : [];
    const siteMeta = new Map<string, any>(siteRows.map((s: any) => [String(s.id), s]));
    const clientIds = Array.from(new Set(siteRows.map((s: any) => s.clientAccountId ? String(s.clientAccountId) : null).filter(Boolean)));
    const clientRows = clientIds.length ? await db.clientAccount.findAll({ where: { id: clientIds, tenantId }, attributes: ['id', 'name', 'commercialName'] }).catch(() => []) : [];
    const clientMeta = new Map<string, any>(clientRows.map((c: any) => [String(c.id), c]));

    const posRows = positionIds.length ? await db.stationPosition.findAll({
      where: { tenantId, id: positionIds },
      attributes: ['id', 'name', 'type', 'startTime', 'endTime', 'platoonOffset'],
    }).catch(() => []) : [];
    const posMeta = new Map<string, any>(posRows.map((p: any) => [String(p.id), p]));

    const rotRows = await db.rotationStyle.findAll({ where: { tenantId }, attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] }).catch(() => []);
    const rotById = new Map<string, any>(rotRows.map((r: any) => [String(r.id), r]));

    const rows: any[] = [];
    for (const a of assigns) {
      const st = stationMeta.get(String(a.stationId));
      const p = a.positionId ? posMeta.get(String(a.positionId)) : null;
      const site = st?.postSiteId ? siteMeta.get(String(st.postSiteId)) : null;
      const client = site?.clientAccountId ? clientMeta.get(String(site.clientAccountId)) : null;
      const rot = st?.rotationStyleId ? rotById.get(String(st.rotationStyleId)) : null;
      const platoon = (a.platoonOffset != null) ? Number(a.platoonOffset) : (p && p.platoonOffset != null ? Number(p.platoonOffset) : 0);

      const cells = days.map((d: any) => {
        const dse = dseOf(new Date(`${d.date}T00:00:00Z`));
        const status: 'day' | 'night' | 'rest' = rot
          ? rotationStatus(dse, platoon, Number(rot.dayShifts) || 0, Number(rot.nightShifts) || 0, Number(rot.restDays) || 0)
          : 'rest';
        return { date: d.date, status };
      });

      rows.push({
        assignmentId: String(a.id),
        stationId: String(a.stationId),
        stationName: st?.stationName || 'Estación',
        sedeName: site?.companyName || null,
        clientName: client ? (client.commercialName || client.name || null) : null,
        positionId: a.positionId ? String(a.positionId) : null,
        positionName: p ? (p.name || (p.type === 'sacafranco' ? 'Sacafranco' : 'Fijo')) : (a.isRelief ? 'Sacafranco' : 'Fijo'),
        positionType: p?.type || (a.isRelief ? 'sacafranco' : 'fijo'),
        window: p && p.startTime && p.endTime ? `${p.startTime} - ${p.endTime}` : null,
        rotationStyleName: rot?.name || null,
        cells,
      });
    }

    return ApiResponseHandler.success(req, res, {
      guardId: sg?.id ? String(sg.id) : null, guardUserId: String(guardUserId),
      startDate: ymd(start), endDate: ymd(end), days, rows, updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
