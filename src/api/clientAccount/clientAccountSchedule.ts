import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import {
  ymd, tenantTz, tzParts, buildDays, resolveWindow, loadShiftIndex, paintCells,
} from '../../services/scheduleGridService';

/**
 * Schedule ("Horario") grid for a client's stations, scoped to one sede. Mirrors
 * Programador › Horario: rows = station positions (fijo/sacafranco) with their
 * assigned guard, columns = days. CRUD (change/assign guard) reuses the existing
 * /guard-assignment endpoints from the frontend.
 *
 * Cells are painted from the REAL generated `shift` rows — the exact same table
 * Programador › Horario reads (`/scheduler/overview`) — not from a re-derived
 * rotation formula. The old formula recomputed D/N/L from the station's
 * rotationStyle and, when a station had no rotationStyleId, fell back to
 * 'rest' for EVERY day. That painted a full-of-turnos sede as an empty wall of
 * L, contradicting Programador. Shifts are generated a year ahead
 * (shiftGenerationService.GENERATION_DAYS), so they are the source of truth for
 * any window this grid can show; rotation math survives only as the fallback
 * that marks a scheduled-but-off day as 'rest'.
 */

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

    // Tenant timezone drives both "today" and how each turno is bucketed into a
    // day column (see tzParts) — UTC would offset the whole grid for Ecuador.
    const tz = await tenantTz(db, tenantId);
    const todayStr = tzParts(now, tz).date;
    const { start, end } = resolveWindow(req.query, todayStr);
    const days = buildDays(start, end, todayStr);

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
      // deletedAt:null matches Programador › overview — without it a removed
      // puesto keeps rendering a phantom row here but not there.
      where: { tenantId, stationId: stationIds, deletedAt: null },
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
    for (const a of assigns) {
      if (a.positionId) assignByPos.set(String(a.positionId), a);
    }
    const guardName = (u: any) => u ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Vigilante') : null;

    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), s]));

    // Real generated turnos for this sede's stations, in the window.
    const shiftIndex = await loadShiftIndex(db, tenantId, stationIds, start, end, tz);

    const rows: any[] = [];
    for (const p of positions) {
      const st = stationMeta.get(String(p.stationId));
      const rot = st?.rotationStyleId ? rotById.get(String(st.rotationStyleId)) : null;
      const a = assignByPos.get(String(p.id)) || null;
      const platoon = (a && a.platoonOffset != null) ? Number(a.platoonOffset) : (Number(p.platoonOffset) || 0);

      const cells = paintCells(days, shiftIndex, {
        positionId: String(p.id),
        stationId: String(p.stationId),
        guardId: a?.guardId ? String(a.guardId) : null,
        rot, platoon,
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
