import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import {
  ymd, parseYmd, tenantTz, tzParts, buildDays, resolveWindow,
  loadShiftIndex, paintCells,
} from '../../services/scheduleGridService';

/**
 * Forward work schedule ("Horario") for ONE security guard. Mirrors the client
 * schedule grid but scoped to the guard's own active assignments: rows = each
 * station/position the guard is assigned to, columns = days, each cell =
 * the real generated turnos for that guard (shared scheduleGridService, the
 * same source Programador › Horario and Cliente › Cobertura read).
 *
 *   GET /tenant/:tenantId/security-guard/:id/schedule?startDate=&endDate=
 *
 * :id may be the securityGuard.id (PK) or the guard's user id. Gated by
 * userRead (mirrors /security-guard/:id/assignments).
 */

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

    // Tenant timezone drives "today" and how each turno buckets into a column.
    const tz = await tenantTz(db, tenantId);
    const todayStr = tzParts(now, tz).date;
    const { start, end } = resolveWindow(req.query, todayStr);
    const days = buildDays(start, end, todayStr);

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

    const stationIds = Array.from(new Set<string>(assigns.map((a: any) => String(a.stationId)).filter(Boolean)));
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

    // Real generated turnos across every station this guard is assigned to.
    const shiftIndex = await loadShiftIndex(db, tenantId, stationIds, start, end, tz);

    const rows: any[] = [];
    for (const a of assigns) {
      const st = stationMeta.get(String(a.stationId));
      const p = a.positionId ? posMeta.get(String(a.positionId)) : null;
      const site = st?.postSiteId ? siteMeta.get(String(st.postSiteId)) : null;
      const client = site?.clientAccountId ? clientMeta.get(String(site.clientAccountId)) : null;
      const rot = st?.rotationStyleId ? rotById.get(String(st.rotationStyleId)) : null;
      const platoon = (a.platoonOffset != null) ? Number(a.platoonOffset) : (p && p.platoonOffset != null ? Number(p.platoonOffset) : 0);

      const cells = paintCells(days, shiftIndex, {
        positionId: a.positionId ? String(a.positionId) : null,
        stationId: String(a.stationId),
        guardId: String(guardUserId),
        rot, platoon,
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
