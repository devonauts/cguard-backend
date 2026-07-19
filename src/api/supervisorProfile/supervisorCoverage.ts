import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { upcomingForUser } from '../../services/supervisorScheduleService';

/**
 * Supervisor coverage + schedule for the CRM (keyed by :userId), so a
 * supervisor's detail page can show WHICH zone/stations they cover and their
 * upcoming shifts — data that previously lived only on the position-centric
 * screen and the mobile /supervisor/me/schedule endpoint.
 */

/**
 * GET /tenant/:tenantId/supervisors/:userId/coverage
 * → { positions: [{ id, name, zone, rotationStyleName, stations: [{id,name}] }] }
 */
export async function coverage(req: any, res: any) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const userId = req.params.userId;

    const assigns = await db.supervisorPositionAssignment.findAll({
      where: { tenantId, supervisorUserId: userId, status: 'active' },
      attributes: ['id', 'positionId', 'platoonOffset', 'startDate'],
    }).catch(() => []);
    if (!assigns.length) return ApiResponseHandler.success(req, res, { positions: [] });

    const positionIds = Array.from(new Set(assigns.map((a: any) => String(a.positionId)).filter(Boolean)));
    const posRows = await db.supervisorPosition.findAll({
      where: { tenantId, id: positionIds },
      attributes: ['id', 'name', 'zone', 'stationIds', 'rotationStyleId', 'mobileStationId', 'startTime', 'endTime'],
    }).catch(() => []);

    // Resolve every referenced station id → name.
    const allStationIds = new Set<string>();
    for (const p of posRows) {
      const ids = Array.isArray(p.stationIds) ? p.stationIds : [];
      for (const s of ids) if (s) allStationIds.add(String(s));
      if (p.mobileStationId) allStationIds.add(String(p.mobileStationId));
    }
    const stationRows = allStationIds.size
      ? await db.station.findAll({ where: { tenantId, id: Array.from(allStationIds) }, attributes: ['id', 'stationName'] }).catch(() => [])
      : [];
    const stationName = new Map<string, string>(stationRows.map((s: any) => [String(s.id), s.stationName || 'Estación']));

    const rotRows = await db.rotationStyle.findAll({ where: { tenantId }, attributes: ['id', 'name'] }).catch(() => []);
    const rotName = new Map<string, string>(rotRows.map((r: any) => [String(r.id), r.name]));

    const positions = posRows.map((p: any) => {
      const ids = Array.isArray(p.stationIds) ? p.stationIds : [];
      const stations = ids.map((sid: any) => ({ id: String(sid), name: stationName.get(String(sid)) || 'Estación' }));
      return {
        id: String(p.id),
        name: p.name || 'Puesto',
        zone: p.zone || null,
        rotationStyleName: p.rotationStyleId ? (rotName.get(String(p.rotationStyleId)) || null) : null,
        window: p.startTime && p.endTime ? `${p.startTime} - ${p.endTime}` : null,
        mobileStation: p.mobileStationId ? { id: String(p.mobileStationId), name: stationName.get(String(p.mobileStationId)) || 'Estación' } : null,
        stations,
      };
    });

    await ApiResponseHandler.success(req, res, { positions });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

/**
 * GET /tenant/:tenantId/supervisors/:userId/schedule
 * → { rows: [{ date, start, end, kind, position }], position }
 * Same generated plan the mobile app reads, but for an admin viewing :userId.
 */
export async function schedule(req: any, res: any) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const userId = req.params.userId;

    const shifts = await upcomingForUser(db, tenantId, userId, 30).catch(() => []);
    const rows = (shifts || []).map((s: any) => ({
      date: s.start ? new Date(s.start).toISOString().slice(0, 10) : null,
      start: s.start, end: s.end, kind: s.kind, position: s.position,
    }));
    await ApiResponseHandler.success(req, res, { rows, position: shifts.length ? shifts[0].position : null });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}
