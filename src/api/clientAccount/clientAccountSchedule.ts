import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

/**
 * Schedule ("Horario") grid for a client's stations, scoped to one sede. Mirrors
 * Programador › Horario: rows = station positions (fijo/sacafranco) with their
 * assigned guard, columns = days, each cell = day/night/rest computed from the
 * station's rotation. CRUD (change/assign guard) reuses the existing
 * /guard-assignment endpoints from the frontend.
 */

// Fixed rotation epoch — must match shiftGenerationService.ROTATION_EPOCH.
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
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();

    // Sedes (selector) + selected sede.
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
    const sedes = (sedeRows || []).map((s: any) => ({ id: String(s.id), name: s.companyName || 'Sede' }));
    const requested = String(req.query.postSiteId || '');
    const selectedSedeId = sedes.find((s) => s.id === requested)?.id || sedes[0]?.id || null;

    // Date window (default: today .. +13 days).
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = parseYmd(req.query.startDate, todayUtc);
    let end = parseYmd(req.query.endDate, new Date(start.getTime() + 13 * 86400000));
    if (end < start) end = new Date(start.getTime() + 13 * 86400000);
    // Cap window at 31 days.
    if ((end.getTime() - start.getTime()) / 86400000 > 31) end = new Date(start.getTime() + 31 * 86400000);
    const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const days: any[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const d = new Date(t);
      days.push({ date: ymd(d), dow: DOW[d.getUTCDay()], day: d.getUTCDate(), isToday: ymd(d) === ymd(todayUtc), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 });
    }

    const empty = () => ApiResponseHandler.success(req, res, { sedes, selectedSedeId, startDate: ymd(start), endDate: ymd(end), days, stations: [], rows: [], updatedAt: now.toISOString() });
    if (!selectedSedeId) return empty();

    const stationRows = await db.station.findAll({
      where: { postSiteId: selectedSedeId, tenantId },
      attributes: ['id', 'stationName', 'scheduleType', 'rotationStyleId'],
      order: [['stationName', 'ASC']],
    });
    const stationIds = stationRows.map((s: any) => String(s.id));
    if (!stationIds.length) return empty();

    // Rotation styles.
    const rotRows = await db.rotationStyle.findAll({ where: { tenantId }, attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] }).catch(() => []);
    const rotById = new Map<string, any>(rotRows.map((r: any) => [String(r.id), r]));

    // Positions.
    const positions = await db.stationPosition.findAll({
      where: { tenantId, stationId: stationIds },
      attributes: ['id', 'stationId', 'name', 'type', 'startTime', 'endTime', 'guardsNeeded', 'sortOrder', 'platoonOffset'],
      order: [['stationId', 'ASC'], ['sortOrder', 'ASC']],
    }).catch(() => []);

    // Active assignments (with guard).
    const assigns = await db.guardAssignment.findAll({
      where: { tenantId, stationId: stationIds, status: 'active' },
      include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'platoonOffset', 'isRelief', 'startDate'],
    }).catch(() => []);
    const assignByPos = new Map<string, any>();
    const assignByStation: Record<string, any[]> = {};
    for (const a of assigns) {
      if (a.positionId) assignByPos.set(String(a.positionId), a);
      const k = String(a.stationId); (assignByStation[k] ||= []).push(a);
    }
    const guardName = (u: any) => u ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Vigilante') : null;

    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), s]));

    const rows: any[] = [];
    for (const p of positions) {
      const st = stationMeta.get(String(p.stationId));
      const rot = st?.rotationStyleId ? rotById.get(String(st.rotationStyleId)) : null;
      const a = assignByPos.get(String(p.id)) || null;
      const platoon = (a && a.platoonOffset != null) ? Number(a.platoonOffset) : (Number(p.platoonOffset) || 0);
      const scheduleType = st?.scheduleType || null;

      const cells = days.map((d: any) => {
        const dse = dseOf(new Date(`${d.date}T00:00:00Z`));
        let status: 'day' | 'night' | 'rest' | 'none';
        if (rot) status = rotationStatus(dse, platoon, Number(rot.dayShifts) || 0, Number(rot.nightShifts) || 0, Number(rot.restDays) || 0);
        else if (scheduleType === '12h-night') status = 'night';
        else if (scheduleType) status = 'day';
        else status = 'none';
        return { date: d.date, status };
      });

      rows.push({
        stationId: String(p.stationId),
        stationName: st?.stationName || 'Estación',
        positionId: String(p.id),
        positionName: p.name || (p.type === 'sacafranco' ? 'Sacafranco' : 'Fijo'),
        positionType: p.type || 'fijo',
        window: p.startTime && p.endTime ? `${p.startTime} - ${p.endTime}` : null,
        assignmentId: a ? String(a.id) : null,
        guardId: a ? String(a.guardId) : null,
        guardName: a ? guardName(a.guard) : null,
        rotationStyleName: rot?.name || null,
        cells,
      });
    }

    const stations = stationRows.map((s: any) => ({ id: String(s.id), name: s.stationName, scheduleType: s.scheduleType, rotationStyleName: s.rotationStyleId ? (rotById.get(String(s.rotationStyleId))?.name || null) : null }));

    return ApiResponseHandler.success(req, res, {
      sedes, selectedSedeId,
      startDate: ymd(start), endDate: ymd(end),
      days, stations, rows,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
