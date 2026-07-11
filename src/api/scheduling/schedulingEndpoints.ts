import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { getGlobalEpoch } from '../../services/shiftGenerationService';
import { haversineDistance } from '../../lib/geofence';
import { autoConfigureStationPositions, optimizeAndAssignSacafrancos } from '../../services/stationAutoConfigService';

// GET /tenant/:tenantId/rotation-styles
export async function rotationStyleList(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const tenantId = req.currentTenant.id;
    const rows = await req.database.rotationStyle.findAll({
      where: {
        [req.database.Sequelize.Op.or]: [
          { tenantId },
          { tenantId: null, isSystem: true },
        ],
        deletedAt: null,
      },
      order: [['isSystem', 'DESC'], ['name', 'ASC']],
    });
    await ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/rotation-style
export async function rotationStyleCreate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationCreate);
    const tenantId = req.currentTenant.id;
    const { name, description, dayShifts, nightShifts, restDays } = req.body?.data || req.body || {};
    const record = await req.database.rotationStyle.create({
      name,
      description,
      dayShifts: parseInt(dayShifts) || 5,
      nightShifts: parseInt(nightShifts) || 0,
      restDays: parseInt(restDays) || 2,
      isSystem: false,
      tenantId,
      createdById: req.currentUser.id,
      updatedById: req.currentUser.id,
    });
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// GET /tenant/:tenantId/station/:stationId/positions
export async function stationPositionList(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const { stationId } = req.params;
    const tenantId = req.currentTenant.id;
    const rows = await req.database.stationPosition.findAll({
      where: { stationId, tenantId, deletedAt: null },
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    await ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/station/:stationId/positions
export async function stationPositionCreate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationCreate);
    const { stationId } = req.params;
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const record = await req.database.stationPosition.create({
      name: data.name || 'Posición',
      type: data.type || 'day',
      startTime: data.startTime || '07:00',
      endTime: data.endTime || '19:00',
      guardsNeeded: parseInt(data.guardsNeeded) || 1,
      sortOrder: parseInt(data.sortOrder) || 0,
      stationId,
      tenantId,
      createdById: req.currentUser.id,
      updatedById: req.currentUser.id,
    });
    await regenerateStationShiftsSafe(req, stationId);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

/**
 * The turno (stationPosition) is the single source of truth for shift times, so
 * any change to a station's positions must rebuild that station's future shifts.
 * `generateShiftsForAssignment` force-deletes future shifts and recreates them
 * from the CURRENT position hours, so this keeps generated shifts from drifting
 * away from the turno. Best-effort: a regen failure never fails the mutation.
 *
 * Coalescing: a burst of position mutations for the same station must NOT stack
 * N full-year regens. Per station we keep one in-flight run; late callers mark
 * it dirty and share its promise, and the loop re-runs ONCE after the current
 * pass so the final rebuild always reads the latest committed positions. Every
 * caller still awaits until a pass that started AFTER its own DB write has
 * finished (the CRM re-fetches /scheduler/overview immediately after the
 * mutation response, so shifts must be persisted before we respond).
 */
const stationRegenInFlight = new Map<
  string,
  { dirty: boolean; latest: { database: any; tenantId: string; userId: string }; running: Promise<void> }
>();

async function regenerateStationShiftsSafe(req: any, stationId: string) {
  if (!stationId) return;
  const latest = { database: req.database, tenantId: req.currentTenant.id, userId: req.currentUser.id };
  const key = `${latest.tenantId}|${stationId}`;

  const existing = stationRegenInFlight.get(key);
  if (existing) {
    // A regen is mid-flight; it may have read positions from before our write.
    // Flag a single follow-up pass and wait for it — never a second parallel run.
    existing.dirty = true;
    existing.latest = latest;
    return existing.running;
  }

  const entry = { dirty: false, latest, running: Promise.resolve() };
  entry.running = (async () => {
    do {
      entry.dirty = false;
      const args = entry.latest;
      try {
        const { regenerateStationShifts } = await import('../../services/shiftGenerationService');
        await regenerateStationShifts(args.database, stationId, args.tenantId, args.userId);
      } catch (e) {
        console.error('[stationPosition] shift regeneration failed:', (e as any)?.message || e);
      }
    } while (entry.dirty);
    // Deleted in the same synchronous continuation as the final dirty check, so
    // no caller can observe (and dirty-flag) an entry whose loop already exited.
    stationRegenInFlight.delete(key);
  })();
  stationRegenInFlight.set(key, entry);
  return entry.running;
}

// PUT /tenant/:tenantId/station/:stationId/positions/:positionId
export async function stationPositionUpdate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const { positionId } = req.params;
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const record = await req.database.stationPosition.findOne({
      where: { id: positionId, tenantId, deletedAt: null },
    });
    if (!record) { res.status(404).send({ message: 'Position not found' }); return; }
    await record.update({
      ...(data.name && { name: data.name }),
      ...(data.type && { type: data.type }),
      ...(data.startTime && { startTime: data.startTime }),
      ...(data.endTime && { endTime: data.endTime }),
      ...(data.guardsNeeded !== undefined && { guardsNeeded: parseInt(data.guardsNeeded) }),
      ...(data.sortOrder !== undefined && { sortOrder: parseInt(data.sortOrder) }),
      updatedById: req.currentUser.id,
    });
    // Hours/type changed → rebuild this station's shifts from the new turno.
    await regenerateStationShiftsSafe(req, record.stationId);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// DELETE /tenant/:tenantId/station/:stationId/positions/:positionId
export async function stationPositionDelete(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const { positionId } = req.params;
    const tenantId = req.currentTenant.id;
    // Capture the station BEFORE deleting so we can rebuild its shifts after.
    const pos = await req.database.stationPosition.findOne({
      where: { id: positionId, tenantId },
      attributes: ['stationId'],
    });
    await req.database.stationPosition.destroy({ where: { id: positionId, tenantId } });
    if (pos?.stationId) await regenerateStationShiftsSafe(req, pos.stationId);
    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// GET /tenant/:tenantId/guard-assignments
export async function guardAssignmentList(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const tenantId = req.currentTenant.id;
    const where: any = { tenantId, deletedAt: null };
    if (req.query.stationId) where.stationId = req.query.stationId;
    if (req.query.guardId) where.guardId = req.query.guardId;
    if (req.query.status) where.status = req.query.status;
    else where.status = 'active';

    const rows = await req.database.guardAssignment.findAll({
      where,
      include: [
        { model: req.database.user, as: 'guard', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: req.database.station, as: 'station', attributes: ['id', 'stationName'] },
        { model: req.database.stationPosition, as: 'position', attributes: ['id', 'name', 'type', 'startTime', 'endTime'] },
        { model: req.database.rotationStyle, as: 'rotationStyle', attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] },
      ],
      order: [['stationId', 'ASC'], ['createdAt', 'ASC']],
    });
    await ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/guard-assignment
// Single write path for ALL guard↔station assignments (rotation + ad-hoc).
export async function guardAssignmentCreate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};

    const { createAssignment, AssignmentValidationError } = await import('../../services/assignmentService');
    try {
      const record = await createAssignment(req.database, tenantId, req.currentUser.id, {
        guardId: data.guardId,
        stationId: data.stationId,
        positionId: data.positionId || null,
        rotationStyleId: data.rotationStyleId || null,
        startDate: data.startDate,
        endDate: data.endDate || null,
        startTime: data.startTime || null,
        endTime: data.endTime || null,
        platoonOffset: data.platoonOffset,
        isRelief: data.isRelief,
      });
      await ApiResponseHandler.success(req, res, record);
    } catch (e: any) {
      if (e instanceof AssignmentValidationError) {
        res.status(400).send({ message: e.message });
        return;
      }
      throw e;
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// DELETE /tenant/:tenantId/guard-assignment/:id
export async function guardAssignmentDelete(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const { id } = req.params;

    // End the assignment
    const record = await req.database.guardAssignment.findOne({ where: { id, tenantId } });
    if (!record) { res.status(404).send({ message: 'Assignment not found' }); return; }
    await record.update({ status: 'ended', endDate: new Date().toISOString().slice(0, 10) });

    // Remove ALL generated shifts for this assignment (past + future) so removing
    // a vigilante leaves no lingering turnos. Attendance (guardShift) is separate.
    await req.database.shift.destroy({
      where: { guardAssignmentId: id, tenantId },
    });

    // Soft-delete the assignment row itself (paranoid → sets deletedAt). Marking it
    // only 'ended' left the row visible to any query that didn't filter status, so
    // removed guards kept reappearing. Now removal takes them out everywhere.
    await record.destroy();

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/guard-assignment/:id/rephase
// Re-anchor a rotation assignment's phase so its REST (libre) block starts on
// the given date, then regenerate the future shifts. This is the "apply this
// L-day change to the rest of the schedule" action: when a generated rotation
// doesn't match how the guards are actually cycling, the planner moves one L
// day and confirms — instead of hand-editing every week of the month.
export async function guardAssignmentRephase(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const { id } = req.params;
    const data = req.body?.data || req.body || {};
    const restStartDate = String(data.restStartDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(restStartDate)) {
      res.status(400).send({ message: 'restStartDate (YYYY-MM-DD) es requerido' });
      return;
    }

    const assignment = await req.database.guardAssignment.findOne({
      where: { id, tenantId, status: 'active' },
    });
    if (!assignment) { res.status(404).send({ message: 'Assignment not found' }); return; }

    // Rotation lives on the STATION; assignment's own value is legacy fallback.
    const station = await req.database.station.findByPk(assignment.stationId, {
      attributes: ['id', 'rotationStyleId'],
    });
    const rotationStyleId = station?.rotationStyleId || assignment.rotationStyleId;
    const rot = rotationStyleId
      ? await req.database.rotationStyle.findByPk(rotationStyleId)
      : null;
    if (!rot) { res.status(400).send({ message: 'El puesto no tiene patrón de rotación' }); return; }

    const dayShifts = rot.dayShifts || 0;
    const nightShifts = rot.nightShifts || 0;
    const restDays = rot.restDays || 0;
    const cycle = dayShifts + nightShifts + restDays;
    if (!(cycle > 0) || !(restDays > 0)) {
      res.status(400).send({ message: 'Patrón de rotación inválido (sin días libres)' });
      return;
    }

    // Same math as shiftGenerationService.getRotationStatus: status(d) reads
    // ((dse − platoonOffset) mod C) against the 2024-01-01 epoch, and the rest
    // block starts at index dayShifts+nightShifts. Solve for the offset that
    // makes restStartDate the FIRST rest day (with 2+ libres, the block starts
    // there and runs consecutively).
    const [y, m, d] = restStartDate.split('-').map(Number);
    const dse = Math.floor(
      (new Date(y, m - 1, d).getTime() - new Date(2024, 0, 1).getTime()) / 86400000,
    );
    const restStartIdx = dayShifts + nightShifts;
    const newOffset = (((dse - restStartIdx) % cycle) + cycle) % cycle;

    await assignment.update({ platoonOffset: newOffset, updatedById: req.currentUser.id });
    // Keep the slot's position in sync so a future re-assign inherits the phase.
    if (assignment.positionId) {
      await req.database.stationPosition.update(
        { platoonOffset: newOffset },
        { where: { id: assignment.positionId, tenantId } },
      );
    }

    const { generateShiftsForAssignment } = await import('../../services/shiftGenerationService');
    await generateShiftsForAssignment(
      req.database,
      assignment.get({ plain: true }),
      tenantId,
      req.currentUser.id,
    );

    await ApiResponseHandler.success(req, res, {
      ok: true,
      platoonOffset: newOffset,
      cycleLength: cycle,
      restDays,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/station/:stationId/auto-positions
// Auto-creates positions based on station scheduleType + generates yearly schedule
export async function stationAutoPositions(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const { stationId } = req.params;
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const scheduleType = data.scheduleType || '24h';
    const rotationStyleId = data.rotationStyleId || null;
    const userId = req.currentUser.id;

    const result = await autoConfigureStationPositions(req.database, {
      stationId,
      tenantId,
      userId,
      scheduleType,
      rotationStyleId,
      data,
      // Single-station path keeps the original behaviour: run the tenant-wide
      // sacafranco optimization + SF-guard assignment as part of this call.
      runSacafrancoOptimize: true,
    });

    await ApiResponseHandler.success(req, res, {
      rows: result.rows,
      count: result.count,
      rotationStyleId: result.rotationStyleId,
      recommendedPlatoonOffset: result.recommendedPlatoonOffset,
      sequenceRule: 'offset = (stationIndex * restDays - workDays) mod cycle',
      sfAvailableAtExecution: result.sfAvailableAtExecution,
      sfAssignedNow: result.sfAssignedNow,
      sfOpenRemaining: result.sfOpenRemaining,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// GET /tenant/:tenantId/scheduler/overview
// Returns all stations with positions and assignments for the scheduler grid view
export async function schedulerOverview(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const tenantId = req.currentTenant.id;

    // Only stations under an ACTIVE post-site (or with no post-site at all). A
    // deleted post-site must not leave orphaned stations showing in the scheduler.
    const Op = req.database.Sequelize.Op;
    const activePostSites = await req.database.businessInfo.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['id'],
    });
    const activePostSiteIds = activePostSites.map((p: any) => p.id);

    const stations = await req.database.station.findAll({
      where: {
        tenantId,
        deletedAt: null,
        [Op.or]: [
          { postSiteId: null },
          { postSiteId: { [Op.in]: activePostSiteIds.length ? activePostSiteIds : ['__none__'] } },
        ],
      },
      attributes: ['id', 'stationName', 'scheduleType', 'rotationStyleId', 'postSiteId'],
      order: [['stationName', 'ASC']],
    });

    const stationIds = stations.map((s: any) => s.id);

    const positions = await req.database.stationPosition.findAll({
      where: { stationId: stationIds, tenantId, deletedAt: null },
      order: [['stationId', 'ASC'], ['sortOrder', 'ASC']],
    });

    const assignments = await req.database.guardAssignment.findAll({
      where: { stationId: stationIds, tenantId, status: 'active', deletedAt: null },
      include: [
        { model: req.database.user, as: 'guard', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: req.database.stationPosition, as: 'position', attributes: ['id', 'name', 'type', 'startTime', 'endTime'] },
        { model: req.database.rotationStyle, as: 'rotationStyle', attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] },
      ],
    });

    // Get shifts for the requested date range
    const startDate = req.query.startDate || new Date().toISOString().slice(0, 10);
    const endDate = req.query.endDate || (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();

    const shifts = await req.database.shift.findAll({
      where: {
        stationId: stationIds,
        tenantId,
        deletedAt: null,
        startTime: { [req.database.Sequelize.Op.gte]: new Date(startDate) },
        endTime: { [req.database.Sequelize.Op.lte]: new Date(endDate + 'T23:59:59') },
      },
      // The scheduler grid only reads id/guardId/stationId/positionId/start+end
      // (+ the scoped guard). Whitelist those so the overview no longer ships the
      // siteTours/tasks/postOrders/checklists/skillSet/remindersSent JSON blobs.
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'startTime', 'endTime'],
      include: [
        { model: req.database.user, as: 'guard', attributes: ['id', 'firstName', 'lastName'] },
      ],
      order: [['startTime', 'ASC']],
    });

    // Get schedule overrides for the date range
    const overrides = await req.database.scheduleOverride?.findAll?.({
      where: {
        tenantId,
        date: { [req.database.Sequelize.Op.between]: [startDate, endDate] },
      },
    }).catch(() => []) || [];

    await ApiResponseHandler.success(req, res, {
      stations: stations.map((s: any) => s.get({ plain: true })),
      positions: positions.map((p: any) => p.get({ plain: true })),
      assignments: assignments.map((a: any) => a.get({ plain: true })),
      shifts: shifts.map((sh: any) => sh.get({ plain: true })),
      overrides: overrides.map((o: any) => o.get ? o.get({ plain: true }) : o),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// GET /tenant/:tenantId/scheduler/staffing
// Returns staffing requirements: how many fijos + sacafrancos needed
export async function schedulerStaffing(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const tenantId = req.currentTenant.id;
    const { Op } = req.database.Sequelize;

    // Get all stations with rotation configured
    const stations = await req.database.station.findAll({
      where: { tenantId, deletedAt: null, rotationStyleId: { [Op.ne]: null } },
      attributes: ['id', 'stationName', 'rotationStyleId'],
      order: [['stationName', 'ASC']],
    });

    // Get all fijo positions
    const fijoPositions = await req.database.stationPosition.findAll({
      where: { tenantId, deletedAt: null, type: 'fijo' },
      attributes: ['id', 'stationId', 'platoonOffset', 'sortOrder'],
    });

    // Build station configs
    const stationConfigs: any[] = [];
    for (const station of stations) {
      const rot = await req.database.rotationStyle.findByPk(station.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
      if (!rot) continue;
      const sFijos = fijoPositions.filter((p: any) => p.stationId === station.id);
      stationConfigs.push({
        stationId: station.id,
        stationName: station.stationName,
        fijoPositions: sFijos.map((f: any) => ({
          platoonOffset: f.platoonOffset || 0,
          dayShifts: rot.dayShifts,
          nightShifts: rot.nightShifts,
          restDays: rot.restDays,
        })),
      });
    }

    // Get SF rotation (from existing or default 6-1)
    let sfRot: any = null;
    const existingSf = await req.database.guardAssignment.findOne({ where: { tenantId, isRelief: true, status: 'active', deletedAt: null } });
    if (existingSf) {
      sfRot = await req.database.rotationStyle.findByPk(existingSf.rotationStyleId, { attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] });
    }
    if (!sfRot) {
      sfRot = await req.database.rotationStyle.findOne({ where: { name: '6-1', isSystem: true }, attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] });
    }
    if (!sfRot) {
      sfRot = { dayShifts: 6, nightShifts: 0, restDays: 1 };
    }

    const { calculateStaffingNeeds } = await import('../../services/shiftGenerationService');
    const staffing = calculateStaffingNeeds(stationConfigs, { dayShifts: sfRot.dayShifts, nightShifts: sfRot.nightShifts, restDays: sfRot.restDays });

    // Count currently assigned guards
    const currentAssignments = await req.database.guardAssignment.findAll({
      where: { tenantId, status: 'active', deletedAt: null },
      attributes: ['guardId', 'isRelief'],
    });
    const fijoGuards = new Set(currentAssignments.filter((a: any) => !a.isRelief && a.guardId).map((a: any) => a.guardId));
    const sfGuards = new Set(currentAssignments.filter((a: any) => a.isRelief && a.guardId).map((a: any) => a.guardId));

    // Build station-level alerts for the requested month (default: current month)
    const now = new Date();
    const year = Math.max(2000, parseInt(String(req.query?.year || ''), 10) || now.getFullYear());
    const month = Math.min(12, Math.max(1, parseInt(String(req.query?.month || ''), 10) || (now.getMonth() + 1)));
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const monthDays: Date[] = [];
    for (let d = 1; d <= monthEnd.getDate(); d++) {
      monthDays.push(new Date(year, month - 1, d));
    }

    const activeAssignments = await req.database.guardAssignment.findAll({
      where: { tenantId, status: 'active', deletedAt: null },
      attributes: ['id', 'stationId', 'positionId', 'isRelief', 'platoonOffset', 'rotationStyleId'],
      include: [
        { model: req.database.stationPosition, as: 'position', attributes: ['id', 'type'] },
        { model: req.database.rotationStyle, as: 'rotationStyle', attributes: ['id', 'dayShifts', 'nightShifts', 'restDays'] },
      ],
    });

    const assignmentStatusForDay = (assignment: any, day: Date): 'work' | 'rest' => {
      const rot = assignment?.rotationStyle;
      if (!rot) return 'work';
      const dayShifts = Number(rot.dayShifts || 0);
      const nightShifts = Number(rot.nightShifts || 0);
      const restDays = Number(rot.restDays || 0);
      const workDays = dayShifts + nightShifts;
      const cycleLength = workDays + restDays;
      if (cycleLength <= 0) return 'work';

      // Single source of truth for the rotation epoch (Phase 3) — must match the
      // generator's anchor or rest-day patterns disagree. Was hardcoded 2024-01-01.
      const dayMid = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const epoch = getGlobalEpoch(dayMid);
      const daysSince = Math.floor((dayMid.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
      const offset = Number(assignment?.platoonOffset || 0);
      const adj = ((daysSince - offset) % cycleLength + cycleLength) % cycleLength;
      return adj < workDays ? 'work' : 'rest';
    };

    const stationMeta = stations.map((s: any) => ({ id: s.id, stationName: s.stationName }));

    const fijoAssignments = activeAssignments.filter((a: any) => !a.isRelief && a.position?.type === 'fijo');
    const sfAssignments = activeAssignments.filter((a: any) => !!a.isRelief);

    const fijoAssignmentsByStation = new Map<string, any[]>();
    for (const a of fijoAssignments) {
      const list = fijoAssignmentsByStation.get(a.stationId) || [];
      list.push(a);
      fijoAssignmentsByStation.set(a.stationId, list);
    }

    const stationsNeedingSfByDate = new Map<string, string[]>();
    for (const day of monthDays) {
      const dateStr = day.toISOString().slice(0, 10);
      const stationsNeeding: string[] = [];
      for (const st of stationMeta) {
        const stAssigns = fijoAssignmentsByStation.get(st.id) || [];
        if (stAssigns.length === 0) continue;
        const anyResting = stAssigns.some((a: any) => assignmentStatusForDay(a, day) === 'rest');
        if (anyResting) stationsNeeding.push(st.id);
      }
      stationsNeedingSfByDate.set(dateStr, stationsNeeding);
    }

    const sfCoverageByStationDate = new Map<string, number>();
    for (const day of monthDays) {
      const dateStr = day.toISOString().slice(0, 10);
      const stationsNeeding = stationsNeedingSfByDate.get(dateStr) || [];
      if (stationsNeeding.length === 0) continue;

      const workingSf = sfAssignments.filter((a: any) => assignmentStatusForDay(a, day) === 'work');
      if (workingSf.length === 0) continue;

      for (let i = 0; i < stationsNeeding.length; i++) {
        const stId = stationsNeeding[i];
        if (i >= workingSf.length) break;
        const key = `${stId}-${dateStr}`;
        sfCoverageByStationDate.set(key, (sfCoverageByStationDate.get(key) || 0) + 1);
      }
    }

    const stationAlerts = stationMeta
      .map((st: any) => {
        const stFijoPositions = fijoPositions.filter((p: any) => p.stationId === st.id);
        const stFijoAssignments = fijoAssignmentsByStation.get(st.id) || [];
        const assignedPosIds = new Set(stFijoAssignments.map((a: any) => a.positionId));
        const missingFijoCount = stFijoPositions.filter((p: any) => !assignedPosIds.has(p.id)).length;

        let sfUncoveredDays = 0;
        for (const day of monthDays) {
          const dateStr = day.toISOString().slice(0, 10);
          const anyResting = stFijoAssignments.some((a: any) => assignmentStatusForDay(a, day) === 'rest');
          if (!anyResting) continue;
          const key = `${st.id}-${dateStr}`;
          const coveredCount = sfCoverageByStationDate.get(key) || 0;
          if (coveredCount <= 0) sfUncoveredDays++;
        }

        return {
          stationId: st.id,
          stationName: st.stationName,
          missingFijoCount,
          sfUncoveredDays,
          severityScore: (missingFijoCount * 10) + sfUncoveredDays,
        };
      })
      .filter((a: any) => a.missingFijoCount > 0 || a.sfUncoveredDays > 0)
      .sort((a: any, b: any) => b.severityScore - a.severityScore);

    await ApiResponseHandler.success(req, res, {
      ...staffing,
      sfRotation: { id: sfRot.id, name: sfRot.name, dayShifts: sfRot.dayShifts, nightShifts: sfRot.nightShifts, restDays: sfRot.restDays },
      currentFijoGuards: fijoGuards.size,
      currentSfGuards: sfGuards.size,
      totalGuardsNeeded: staffing.fijosNeeded + staffing.sacafrancosNeeded,
      alertPeriod: { year, month, from: monthStart.toISOString().slice(0, 10), to: monthEnd.toISOString().slice(0, 10) },
      stationAlerts,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/scheduler/auto-assign
export async function schedulerAutoAssign(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const { Op } = req.database.Sequelize;

    const [stations, positions, existingAssignments, guards, rotationStyles] = await Promise.all([
      req.database.station.findAll({ where: { tenantId, deletedAt: null }, attributes: ['id', 'stationName', 'latitud', 'longitud', 'scheduleType', 'rotationStyleId'] }),
      req.database.stationPosition.findAll({ where: { tenantId, deletedAt: null }, order: [['stationId', 'ASC'], ['sortOrder', 'ASC']] }),
      req.database.guardAssignment.findAll({ where: { tenantId, status: 'active', deletedAt: null } }),
      req.database.securityGuard.findAll({ where: { tenantId, deletedAt: null }, attributes: ['id', 'fullName', 'address', 'guardType', 'guardId', 'latitude', 'longitude'] }),
      req.database.rotationStyle.findAll({ where: { [Op.or]: [{ tenantId }, { tenantId: null, isSystem: true }] } }),
    ]);

    // `liveAssignments` tracks the current active assignments. It is re-fetched
    // after the unconfigured-station bootstrap below (which may create SF
    // assignments) so the demand "already assigned" checks and available-guard
    // sets stay correct.
    let liveAssignments = existingAssignments;
    let assignedGuardIds = new Set(liveAssignments.map((a: any) => a.guardId));
    let availableGuards = guards.filter((g: any) => !assignedGuardIds.has(g.guardId));
    let titulares = availableGuards.filter((g: any) => g.guardType === 'titular');
    let sacafrancos = availableGuards.filter((g: any) => g.guardType === 'sacafranco');

    // Real proximity (Phase 4): great-circle distance in metres from the guard's
    // geocoded home to the station. Guards with no coordinates (not yet geocoded)
    // sort LAST (Infinity) so located guards are placed by true nearness first.
    const getDistanceM = (guard: any, stationLat: string, stationLng: string): number => {
      const gLat = Number(guard?.latitude);
      const gLng = Number(guard?.longitude);
      const sLat = parseFloat(stationLat);
      const sLng = parseFloat(stationLng);
      if (![gLat, gLng, sLat, sLng].every((n) => Number.isFinite(n))) return Number.POSITIVE_INFINITY;
      if (gLat === 0 && gLng === 0) return Number.POSITIVE_INFINITY;
      return haversineDistance(gLat, gLng, sLat, sLng);
    };

    // Guard homes and station coordinates never change within this request, so
    // each (guard, station) distance is computed at most once; the demand loops
    // below revisit the same stations for every open slot.
    const distanceCache = new Map<string, number>();
    const getDistanceCached = (guard: any, station: any): number => {
      const key = `${guard.id}|${station.id}`;
      let d = distanceCache.get(key);
      if (d === undefined) {
        d = getDistanceM(guard, station.latitud, station.longitud);
        distanceCache.set(key, d);
      }
      return d;
    };

    // Group positions by station
    let positionsByStation = new Map<string, any[]>();
    positions.forEach((p: any) => { const list = positionsByStation.get(p.stationId) || []; list.push(p.get({ plain: true })); positionsByStation.set(p.stationId, list); });

    // Auto-configure rotation styles for stations without one
    const stationRotationUpdates = new Map<string, string>();
    for (const station of stations) {
      const s: any = station.get({ plain: true });
      if (!s.rotationStyleId) {
        const sType = s.scheduleType || '24h';
        // 10-day cycle for everyone so stations sync with the sacafranco:
        // 24h → 4-4-2 (fijos swap day/night); 12h → 8-2 (single shift).
        const { ensureRotationStyle } = await import('../../services/stationAutoConfigService');
        const rotId = sType === '24h'
          ? (rotationStyles.find((r: any) => r.name === '4-4-2')?.id || rotationStyles[0]?.id)
          : await ensureRotationStyle(req.database, '8-2', 8, 0, 2);
        await req.database.station.update({ rotationStyleId: rotId, scheduleType: sType }, { where: { id: s.id, tenantId } });
        if (rotId) stationRotationUpdates.set(s.id, rotId);
      }
    }

    // Bootstrap unconfigured stations: stations that currently have ZERO positions
    // contribute zero demand, so the auto-allocate would produce nothing for them.
    // Create their fijo/sacafranco positions + yearly schedule via the shared
    // helper. IMPORTANT: only for stations with ZERO positions — the helper
    // DELETES existing positions, so calling it for a configured station would be
    // destructive. We pass runSacafrancoOptimize=false per station and run the
    // tenant-wide optimizeSacafrancos ONCE afterwards to avoid O(n^2) passes.
    const stationsToBootstrap = stations.filter((station: any) => {
      const list = positionsByStation.get(station.id);
      return !list || list.length === 0;
    });

    if (stationsToBootstrap.length > 0) {
      for (const station of stationsToBootstrap) {
        const s: any = station.get({ plain: true });
        try {
          await autoConfigureStationPositions(req.database, {
            stationId: s.id,
            tenantId,
            userId,
            scheduleType: s.scheduleType || '24h',
            rotationStyleId: s.rotationStyleId || stationRotationUpdates.get(s.id) || null,
            runSacafrancoOptimize: false,
          });
        } catch (e) {
          console.error('[autoAssign] bootstrap autoConfigureStationPositions error for station', s.id, e);
        }
      }

      // Run the tenant-wide sacafranco optimization + SF-guard assignment ONCE
      // (instead of once per station) now that all empty stations have positions.
      try {
        await optimizeAndAssignSacafrancos(req.database, tenantId, userId);
      } catch (e) {
        console.error('[autoAssign] bootstrap optimizeAndAssignSacafrancos error:', e);
      }

      // Re-fetch positions + active assignments so the demand loops below see the
      // newly created positions and any SF assignments the bootstrap just made.
      const [freshPositions, freshAssignments] = await Promise.all([
        req.database.stationPosition.findAll({ where: { tenantId, deletedAt: null }, order: [['stationId', 'ASC'], ['sortOrder', 'ASC']] }),
        req.database.guardAssignment.findAll({ where: { tenantId, status: 'active', deletedAt: null } }),
      ]);

      positionsByStation = new Map<string, any[]>();
      freshPositions.forEach((p: any) => { const list = positionsByStation.get(p.stationId) || []; list.push(p.get({ plain: true })); positionsByStation.set(p.stationId, list); });

      liveAssignments = freshAssignments;
      assignedGuardIds = new Set(liveAssignments.map((a: any) => a.guardId));
      availableGuards = guards.filter((g: any) => !assignedGuardIds.has(g.guardId));
      titulares = availableGuards.filter((g: any) => g.guardType === 'titular');
      sacafrancos = availableGuards.filter((g: any) => g.guardType === 'sacafranco');
    }

    const stationsPlain = stations.map((s: any) => {
      const plain = s.get({ plain: true });
      // Apply the rotation-style auto-config above so demand/assignments use the
      // up-to-date rotationStyleId rather than the stale (null) loaded value.
      const updatedRot = stationRotationUpdates.get(plain.id);
      if (updatedRot) plain.rotationStyleId = updatedRot;
      return plain;
    });
    const newAssignments: any[] = [];

    // Build demand: unfilled fijo positions (carry the position's platoonOffset —
    // it's already staggered per fijo by autoConfig/optimizeSacafrancos, so the
    // assignment must inherit it rather than an arbitrary counter).
    const demand: { stationId: string; positionId: string; type: string; platoonOffset: number; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type === 'sacafranco') continue;
        if (!liveAssignments.some((a: any) => a.positionId === pos.id)) {
          demand.push({ stationId: station.id, positionId: pos.id, type: pos.type, platoonOffset: pos.platoonOffset || 0, station });
        }
      }
    }

    // Assign titulares to nearest open positions. Demand is grouped by station,
    // and taking the head (shift) keeps the remaining pool sorted for that same
    // station, so we only re-sort when the slot's station changes — the picks
    // are identical to sorting every slot (sort is stable, so a re-sort of an
    // already-sorted pool is a no-op even across equal distances).
    let guardsLeft = [...titulares];
    let titularSortedStationId: string | null = null;
    for (const slot of demand) {
      if (guardsLeft.length === 0) break;
      if (titularSortedStationId !== slot.stationId) {
        guardsLeft.sort((a: any, b: any) => getDistanceCached(a, slot.station) - getDistanceCached(b, slot.station));
        titularSortedStationId = slot.stationId;
      }
      const best: any = guardsLeft.shift();
      newAssignments.push({
        guardId: best.guardId, stationId: slot.stationId, positionId: slot.positionId,
        rotationStyleId: slot.station.rotationStyleId, startDate: new Date().toISOString().slice(0, 10),
        platoonOffset: slot.platoonOffset, isRelief: false, status: 'active', tenantId, createdById: userId, updatedById: userId,
      });
    }

    // Assign sacafrancos to sacafranco positions (reuse across stations)
    const reliefDemand: { stationId: string; positionId: string; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type !== 'sacafranco') continue;
        if (!liveAssignments.some((a: any) => a.positionId === pos.id)) {
          reliefDemand.push({ stationId: station.id, positionId: pos.id, station });
        }
      }
    }

    let sacafLeft = [...sacafrancos];
    let sacafSortedStationId: string | null = null;
    for (const slot of reliefDemand) {
      // Refilling restores the ORIGINAL pool order, so the sorted-for marker
      // must reset to force a re-sort (matching the always-sort behavior).
      if (sacafLeft.length === 0) { sacafLeft = [...sacafrancos]; sacafSortedStationId = null; if (sacafLeft.length === 0) break; }
      if (sacafSortedStationId !== slot.stationId) {
        sacafLeft.sort((a: any, b: any) => getDistanceCached(a, slot.station) - getDistanceCached(b, slot.station));
        sacafSortedStationId = slot.stationId;
      }
      const best: any = sacafLeft.shift();
      newAssignments.push({
        guardId: best.guardId, stationId: slot.stationId, positionId: slot.positionId,
        rotationStyleId: slot.station.rotationStyleId, startDate: new Date().toISOString().slice(0, 10),
        platoonOffset: 0, isRelief: true, status: 'active', tenantId, createdById: userId, updatedById: userId,
      });
    }

    // Bulk create and generate shifts
    if (newAssignments.length > 0) {
      const created = await req.database.guardAssignment.bulkCreate(newAssignments);
      const { generateShiftsForAssignment } = await import('../../services/shiftGenerationService');
      for (const record of created) {
        try { await generateShiftsForAssignment(req.database, record.get({ plain: true }), tenantId, userId); }
        catch (e) { console.error('[autoAssign] shift gen error:', record.id, e); }
      }
    }

    await ApiResponseHandler.success(req, res, {
      assignmentsCreated: newAssignments.length,
      titularesAssigned: newAssignments.filter(a => !a.isRelief).length,
      sacafrancosAssigned: newAssignments.filter(a => a.isRelief).length,
      unassignedRemaining: guardsLeft.length,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// ─── Schedule Overrides (V, PM, F, manual shifts) ────────────────────────────

// GET /tenant/:tenantId/schedule-overrides?startDate=&endDate=
export async function scheduleOverrideList(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const tenantId = req.currentTenant.id;
    const { startDate, endDate, guardId } = req.query;
    const where: any = { tenantId };
    if (startDate && endDate) {
      where.date = { [req.database.Sequelize.Op.between]: [startDate, endDate] };
    }
    if (guardId) where.guardId = guardId;

    const rows = await req.database.scheduleOverride.findAll({
      where,
      include: [{ model: req.database.user, as: 'guard', attributes: ['id', 'firstName', 'lastName', 'email'] }],
      order: [['date', 'ASC']],
    });
    await ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/schedule-overrides
export async function scheduleOverrideCreate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationCreate);
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const { guardId, assignmentId, date, type, note } = req.body?.data || req.body || {};

    if (!guardId || !date || !type) {
      return await ApiResponseHandler.error(req, res, { message: 'guardId, date and type are required', code: 400 });
    }

    const validTypes = ['V', 'PM', 'F', '24', 'D', 'N', 'L'];
    if (!validTypes.includes(type)) {
      return await ApiResponseHandler.error(req, res, { message: `type must be one of: ${validTypes.join(', ')}`, code: 400 });
    }

    // Upsert: if override already exists for this guard+date, update it
    const [record, created] = await req.database.scheduleOverride.findOrCreate({
      where: { guardId, date, tenantId },
      defaults: { guardId, assignmentId, date, type, note, tenantId, createdById: userId },
    });

    if (!created) {
      await record.update({ type, note, assignmentId });
    }

    // Propagate ABSENCE overrides to the live schedule (Phase 7): vacation /
    // permiso / falta / libre mean the guard is OFF that day, so remove their
    // shift — this frees the puesto and the coverage analyzer surfaces the gap.
    // Working overrides (D/N/24) leave the shift as-is.
    if (['V', 'PM', 'F', 'L'].includes(type)) {
      try {
        const { Op } = req.database.Sequelize;
        const tenant = await req.database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
        const tz = (tenant && tenant.timezone) || 'UTC';
        const dayAnchor = new Date(`${date}T00:00:00Z`);
        const from = new Date(dayAnchor.getTime() - 24 * 3600000);
        const to = new Date(dayAnchor.getTime() + 48 * 3600000);
        const localDate = (d: any) => {
          try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
          } catch {
            return new Date(d).toISOString().slice(0, 10);
          }
        };
        const shifts = await req.database.shift.findAll({
          where: { guardId, tenantId, startTime: { [Op.gte]: from, [Op.lt]: to } },
          attributes: ['id', 'startTime'],
        });
        const toDelete = shifts.filter((s: any) => localDate(s.startTime) === date).map((s: any) => s.id);
        if (toDelete.length) {
          await req.database.shift.destroy({ where: { id: toDelete, tenantId }, force: true });
        }
      } catch (e: any) {
        console.warn('[scheduleOverride] shift propagation failed:', e?.message || e);
      }
    }

    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// DELETE /tenant/:tenantId/schedule-overrides/:id
export async function scheduleOverrideDelete(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationCreate);
    const tenantId = req.currentTenant.id;
    const { id } = req.params;

    await req.database.scheduleOverride.destroy({ where: { id, tenantId } });
    await ApiResponseHandler.success(req, res, { deleted: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/station/:stationId/generate-yearly
// Generate full year schedule for a station
export async function stationGenerateYearly(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const { stationId } = req.params;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;

    // Verify station has rotation configured
    const station = await req.database.station.findByPk(stationId, { attributes: ['id', 'rotationStyleId'] });
    if (!station?.rotationStyleId) {
      res.status(400).send({ message: 'La estación no tiene un estilo de rotación configurado.' });
      return;
    }

    const { generateYearlyScheduleForStation } = await import('../../services/shiftGenerationService');
    const result = await generateYearlyScheduleForStation(req.database, stationId, tenantId, userId);

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/scheduler/optimize-sacafrancos
// Optimize sacafranco coverage across all stations
// Body: { rotationStyleId?: string } — optional, sets sacafranco rotation for all
export async function schedulerOptimizeSacafrancos(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const data = req.body?.data || req.body || {};
    const sacafrancoRotationStyleId = data.rotationStyleId || undefined;

    const { optimizeSacafrancos, SacafrancoOptimizeInProgressError } = await import('../../services/shiftGenerationService');
    try {
      const result = await optimizeSacafrancos(req.database, tenantId, userId, sacafrancoRotationStyleId);
      await ApiResponseHandler.success(req, res, result);
    } catch (e: any) {
      if (e instanceof SacafrancoOptimizeInProgressError) {
        res.status(409).send({ message: e.message });
        return;
      }
      throw e;
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// POST /tenant/:tenantId/scheduler/ai-recommend
// Get AI-powered scheduling recommendations
export async function schedulerAiRecommend(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const { type, stationName, scheduleType, question } = data;
    // type: 'station' | 'optimize' | 'analyze' (free-form question)

    const { Op } = req.database.Sequelize;

    // Build rich context with offsets and rotation details
    const stations = await req.database.station.findAll({
      where: { tenantId, deletedAt: null, rotationStyleId: { [Op.ne]: null } },
      attributes: ['id', 'stationName', 'scheduleType', 'rotationStyleId'],
      order: [['stationName', 'ASC']],
    });
    const fijoPositions = await req.database.stationPosition.findAll({
      where: { tenantId, deletedAt: null, type: 'fijo' },
      attributes: ['id', 'stationId', 'platoonOffset'],
    });
    const sfPositions = await req.database.stationPosition.findAll({
      where: { tenantId, deletedAt: null, type: 'sacafranco' },
      attributes: ['id', 'platoonOffset'],
    });
    const activeAssignments = await req.database.guardAssignment.findAll({
      where: { tenantId, status: 'active', deletedAt: null },
      attributes: ['id', 'guardId', 'stationId', 'isRelief', 'positionId'],
    });

    // Get rotation details for richer context
    const rotationCache = new Map<string, any>();
    for (const station of stations) {
      if (!rotationCache.has(station.rotationStyleId)) {
        const rot = await req.database.rotationStyle.findByPk(station.rotationStyleId, {
          attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'],
        });
        if (rot) rotationCache.set(station.rotationStyleId, rot);
      }
    }

    // Calculate daily demand across the 10-day super-cycle (all stations sync to it).
    const cycle = 10;
    const dailyDemand: number[] = [];
    for (let day = 0; day < cycle; day++) {
      let stationsResting = 0;
      for (const station of stations) {
        const rot = rotationCache.get(station.rotationStyleId);
        if (!rot) continue;
        const stFijos = fijoPositions.filter((p: any) => p.stationId === station.id);
        const stCycle = rot.dayShifts + rot.nightShifts + rot.restDays;
        const anyResting = stFijos.some((f: any) => {
          const adj = ((day - (f.platoonOffset || 0)) % stCycle + stCycle) % stCycle;
          return adj >= rot.dayShifts + rot.nightShifts;
        });
        if (anyResting) stationsResting++;
      }
      dailyDemand.push(stationsResting);
    }

    const peakDemand = Math.max(...dailyDemand, 0);
    const currentFijoGuards = activeAssignments.filter((a: any) => !a.isRelief).length;
    const currentSfGuards = activeAssignments.filter((a: any) => a.isRelief).length;
    const sfWorkCapacity = sfPositions.length * 8; // 4-4-2 rotation: 8 work days per SF per 10-day cycle
    const totalRestSlots = dailyDemand.reduce((s, d) => s + d, 0);
    const sfUtilization = sfWorkCapacity > 0 ? Math.round((totalRestSlots / sfWorkCapacity) * 100) : 0;

    const context = {
      totalStations: stations.length,
      totalFijos: fijoPositions.length,
      totalSacafrancos: sfPositions.length,
      currentGuards: currentFijoGuards + currentSfGuards,
      peakDemand,
      dailyDemand,
      sfUtilization,
      laborRegulations: 'Ecuador: 8h/day max, 40h/week, rest mandatory',
      stations: stations.map((s: any) => {
        const rot = rotationCache.get(s.rotationStyleId);
        const stFijos = fijoPositions.filter((p: any) => p.stationId === s.id);
        const offset = stFijos[0]?.platoonOffset ?? 0;
        const workDays = rot ? rot.dayShifts + rot.nightShifts : 5;
        const stCycle = rot ? rot.dayShifts + rot.nightShifts + rot.restDays : 7;
        return {
          stationName: s.stationName,
          scheduleType: s.scheduleType || '12h-day',
          currentRotation: rot?.name || undefined,
          fijoCount: stFijos.length,
          currentGuards: activeAssignments.filter((a: any) => a.stationId === s.id && !a.isRelief).length,
          platoonOffset: offset,
          restDaysStart: (offset + workDays) % stCycle,
        };
      }),
    };

    const { getStationRecommendation, getScheduleOptimization, analyzeScenario } = await import('../../services/aiSchedulingService');

    let result: any;
    if (type === 'station' && stationName) {
      result = await getStationRecommendation(stationName, scheduleType || '12h-day', context);
    } else if (type === 'analyze' && question) {
      const analysis = await analyzeScenario(question, context);
      result = { recommendation: analysis };
    } else {
      const optimization = await getScheduleOptimization(context);
      result = { recommendation: optimization };
    }

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    console.error('[schedulerAiRecommend]', error);
    await ApiResponseHandler.error(req, res, error);
  }
}
