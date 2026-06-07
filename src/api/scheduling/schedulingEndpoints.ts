import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { getGlobalEpoch } from '../../services/shiftGenerationService';
import { haversineDistance } from '../../lib/geofence';

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
 */
async function regenerateStationShiftsSafe(req: any, stationId: string) {
  if (!stationId) return;
  try {
    const { regenerateStationShifts } = await import('../../services/shiftGenerationService');
    await regenerateStationShifts(req.database, stationId, req.currentTenant.id, req.currentUser.id);
  } catch (e) {
    console.error('[stationPosition] shift regeneration failed:', (e as any)?.message || e);
  }
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

    // Delete future auto-generated shifts for this assignment
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await req.database.shift.destroy({
      where: {
        guardAssignmentId: id,
        tenantId,
        startTime: { [req.database.Sequelize.Op.gte]: today },
      },
    });

    await ApiResponseHandler.success(req, res, { ok: true });
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
    let rotationStyleId = data.rotationStyleId || null;

    // Auto-pick recommended rotation if not specified
    if (!rotationStyleId) {
      let recommendedName: string;
      if (scheduleType === '24h') {
        recommendedName = '4-4-2'; // 4 day, 4 night, 2 rest — standard for 24H
      } else {
        recommendedName = '5-2'; // 5 work, 2 rest — standard for 12H
      }
      const recommended = await req.database.rotationStyle.findOne({ where: { name: recommendedName, isSystem: true } });
      rotationStyleId = recommended?.id || null;
    }

    // Update station scheduleType and rotationStyleId
    const stationUpdate: any = { scheduleType };
    if (rotationStyleId) stationUpdate.rotationStyleId = rotationStyleId;
    await req.database.station.update(stationUpdate, { where: { id: stationId, tenantId } });

    // Delete assignments and shifts referencing existing positions, then delete positions
    const existingPositions = await req.database.stationPosition.findAll({ where: { stationId, tenantId }, attributes: ['id'] });
    const positionIds = existingPositions.map((p: any) => p.id);
    if (positionIds.length > 0) {
      await req.database.shift.destroy({ where: { positionId: positionIds, tenantId }, force: true });
      await req.database.guardAssignment.destroy({ where: { positionId: positionIds, tenantId }, force: true });
      await req.database.stationPosition.destroy({ where: { id: positionIds, tenantId }, force: true });
    }

    const positions: any[] = [];
    const userId = req.currentUser.id;
    const now = new Date();

    // Calculate recommended sequential station offset (same algorithm as sacafranco optimizer)
    // so newly added stations immediately follow global sequence.
    let cycleLength = 7;
    let workDays = 5;
    let restDays = 2;
    if (rotationStyleId) {
      const rot = await req.database.rotationStyle.findByPk(rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
      if (rot) {
        workDays = (rot.dayShifts || 0) + (rot.nightShifts || 0);
        restDays = rot.restDays || 1;
        cycleLength = workDays + restDays;
      }
    }

    // Build ordered station group with same cycle and compute this station index in sequence.
    let recommendedStationOffset = 0;
    if (cycleLength > 0) {
      const allStations = await req.database.station.findAll({
        where: { tenantId, deletedAt: null, rotationStyleId: { [req.database.Sequelize.Op.ne]: null } },
        attributes: ['id', 'stationName', 'rotationStyleId'],
        order: [['stationName', 'ASC']],
      });

      const rotationCache = new Map<string, any>();
      for (const st of allStations) {
        if (!rotationCache.has(st.rotationStyleId)) {
          const r = await req.database.rotationStyle.findByPk(st.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
          if (r) rotationCache.set(st.rotationStyleId, r);
        }
      }

      const sameCycleStations = allStations.filter((st: any) => {
        const r = rotationCache.get(st.rotationStyleId);
        if (!r) return false;
        const c = (r.dayShifts || 0) + (r.nightShifts || 0) + (r.restDays || 0);
        return c === cycleLength;
      });

      const currentIndex = sameCycleStations.findIndex((st: any) => st.id === stationId);
      const stationIndex = currentIndex >= 0 ? currentIndex : sameCycleStations.length;
      recommendedStationOffset = (stationIndex * restDays - workDays + cycleLength * 10) % cycleLength;
    }

    if (scheduleType === '24h') {
      // 24h station: keep station-level sequential rest pattern (same offset for both fijo slots)
      positions.push(
        { name: 'Fijo 1', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Fijo 2', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 1, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    } else if (scheduleType === '12h-day' || scheduleType === '12h-night') {
      const start = scheduleType === '12h-day' ? '07:00' : '19:00';
      const end = scheduleType === '12h-day' ? '19:00' : '07:00';
      positions.push(
        { name: 'Fijo 1', type: 'fijo', startTime: start, endTime: end, guardsNeeded: 1, sortOrder: 0, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    } else {
      // Custom
      const customStart = data.startTime || '07:00';
      const customEnd = data.endTime || '19:00';
      positions.push(
        { name: 'Fijo 1', type: 'fijo', startTime: customStart, endTime: customEnd, guardsNeeded: 1, sortOrder: 0, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    }

    await req.database.stationPosition.bulkCreate(positions);
    const created = await req.database.stationPosition.findAll({
      where: { stationId, tenantId, deletedAt: null },
      order: [['sortOrder', 'ASC']],
    });

    let sfAvailableAtExecution = 0;
    let sfAssignedNow = 0;
    let sfOpenRemaining = 0;

    try {
      const { generateYearlyScheduleForStation, optimizeSacafrancos, generateShiftsForAssignment } = await import('../../services/shiftGenerationService');
      await generateYearlyScheduleForStation(req.database, stationId, tenantId, userId);
      // Auto-optimize: ensures sequence across ALL stations
      await optimizeSacafrancos(req.database, tenantId, userId);

      // Auto-assign available SF guards to unfilled sacafranco positions (if any)
      const [sfPositions, activeAssignments, sfGuards, stationMap] = await Promise.all([
        req.database.stationPosition.findAll({ where: { tenantId, deletedAt: null, type: 'sacafranco' } }),
        req.database.guardAssignment.findAll({ where: { tenantId, status: 'active', deletedAt: null }, attributes: ['guardId', 'positionId'] }),
        req.database.securityGuard.findAll({ where: { tenantId, deletedAt: null }, attributes: ['guardId', 'guardType'] }),
        req.database.station.findAll({ where: { tenantId, deletedAt: null }, attributes: ['id', 'rotationStyleId'] }),
      ]);

      const assignedGuardIds = new Set(activeAssignments.map((a: any) => a.guardId));
      const assignedSfPositionIds = new Set(activeAssignments.map((a: any) => a.positionId));
      const availableSfGuards = sfGuards.filter((g: any) =>
        g.guardId &&
        !assignedGuardIds.has(g.guardId) &&
        String(g.guardType || '').toLowerCase() === 'sacafranco'
      );

      const openSfPositions = sfPositions.filter((p: any) => !assignedSfPositionIds.has(p.id));
      sfAvailableAtExecution = availableSfGuards.length;

      if (availableSfGuards.length > 0 && openSfPositions.length > 0) {
        const byStation = new Map<string, any>();
        stationMap.forEach((s: any) => byStation.set(s.id, s));
        const sfRot = await req.database.rotationStyle.findOne({ where: { name: '6-1', isSystem: true } });
        const startDate = new Date().toISOString().slice(0, 10);

        const createCount = Math.min(availableSfGuards.length, openSfPositions.length);
        for (let i = 0; i < createCount; i++) {
          const guard = availableSfGuards[i];
          const pos = openSfPositions[i];
          const station = byStation.get(pos.stationId);
          const assignment = await req.database.guardAssignment.create({
            guardId: guard.guardId,
            stationId: pos.stationId,
            positionId: pos.id,
            rotationStyleId: sfRot?.id || station?.rotationStyleId,
            startDate,
            endDate: null,
            platoonOffset: pos.platoonOffset || 0,
            isRelief: true,
            status: 'active',
            tenantId,
            createdById: userId,
            updatedById: userId,
          });

          await generateShiftsForAssignment(req.database, assignment.get({ plain: true }), tenantId, userId);
          sfAssignedNow++;
        }
      }

      sfOpenRemaining = Math.max(0, openSfPositions.length - sfAssignedNow);
    } catch (e) {
      console.error('[stationAutoPositions] Yearly generation / sacafranco optimization error:', e);
    }

    await ApiResponseHandler.success(req, res, {
      rows: created,
      count: created.length,
      rotationStyleId,
      recommendedPlatoonOffset: recommendedStationOffset,
      sequenceRule: 'offset = (stationIndex * restDays - workDays) mod cycle',
      sfAvailableAtExecution,
      sfAssignedNow,
      sfOpenRemaining,
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

    const stations = await req.database.station.findAll({
      where: { tenantId, deletedAt: null },
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

    const assignedGuardIds = new Set(existingAssignments.map((a: any) => a.guardId));
    const availableGuards = guards.filter((g: any) => !assignedGuardIds.has(g.guardId));
    const titulares = availableGuards.filter((g: any) => g.guardType === 'titular');
    const sacafrancos = availableGuards.filter((g: any) => g.guardType === 'sacafranco');

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

    // Group positions by station
    const positionsByStation = new Map<string, any[]>();
    positions.forEach((p: any) => { const list = positionsByStation.get(p.stationId) || []; list.push(p.get({ plain: true })); positionsByStation.set(p.stationId, list); });

    // Auto-configure rotation styles for stations without one
    for (const station of stations) {
      const s: any = station.get({ plain: true });
      if (!s.rotationStyleId) {
        const sType = s.scheduleType || '24h';
        const rotId = sType === '24h'
          ? (rotationStyles.find((r: any) => r.name === '4-4-2')?.id || rotationStyles[0]?.id)
          : (rotationStyles.find((r: any) => r.name === '5-2')?.id || rotationStyles[0]?.id);
        await req.database.station.update({ rotationStyleId: rotId, scheduleType: sType }, { where: { id: s.id, tenantId } });
        s.rotationStyleId = rotId;
      }
    }

    const stationsPlain = stations.map((s: any) => s.get({ plain: true }));
    const newAssignments: any[] = [];

    // Build demand: unfilled fijo positions
    const demand: { stationId: string; positionId: string; type: string; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type === 'sacafranco') continue;
        if (!existingAssignments.some((a: any) => a.positionId === pos.id)) {
          demand.push({ stationId: station.id, positionId: pos.id, type: pos.type, station });
        }
      }
    }

    // Assign titulares to nearest open positions
    let guardsLeft = [...titulares];
    let platoonCounter = 0;
    for (const slot of demand) {
      if (guardsLeft.length === 0) break;
      guardsLeft.sort((a: any, b: any) => getDistanceM(a, slot.station.latitud, slot.station.longitud) - getDistanceM(b, slot.station.latitud, slot.station.longitud));
      const best: any = guardsLeft.shift();
      newAssignments.push({
        guardId: best.guardId, stationId: slot.stationId, positionId: slot.positionId,
        rotationStyleId: slot.station.rotationStyleId, startDate: new Date().toISOString().slice(0, 10),
        platoonOffset: platoonCounter % 3, isRelief: false, status: 'active', tenantId, createdById: userId, updatedById: userId,
      });
      platoonCounter++;
    }

    // Assign sacafrancos to sacafranco positions (reuse across stations)
    const reliefDemand: { stationId: string; positionId: string; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type !== 'sacafranco') continue;
        if (!existingAssignments.some((a: any) => a.positionId === pos.id)) {
          reliefDemand.push({ stationId: station.id, positionId: pos.id, station });
        }
      }
    }

    let sacafLeft = [...sacafrancos];
    for (const slot of reliefDemand) {
      if (sacafLeft.length === 0) { sacafLeft = [...sacafrancos]; if (sacafLeft.length === 0) break; }
      sacafLeft.sort((a: any, b: any) => getDistanceM(a, slot.station.latitud, slot.station.longitud) - getDistanceM(b, slot.station.latitud, slot.station.longitud));
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

    const { optimizeSacafrancos } = await import('../../services/shiftGenerationService');
    const result = await optimizeSacafrancos(req.database, tenantId, userId, sacafrancoRotationStyleId);

    await ApiResponseHandler.success(req, res, result);
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

    // Calculate daily demand across a super-cycle
    const cycle = 7; // Most common cycle
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
    const sfWorkCapacity = sfPositions.length * 6; // 6-1 rotation: 6 work days per SF per cycle
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
