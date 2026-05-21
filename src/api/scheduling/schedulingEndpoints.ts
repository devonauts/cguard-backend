import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

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
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
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
    await req.database.stationPosition.destroy({ where: { id: positionId, tenantId } });
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
export async function guardAssignmentCreate(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const { guardId, stationId, positionId, startDate, endDate, platoonOffset, isRelief } = data;
    let rotationStyleId = data.rotationStyleId;

    if (!guardId || !stationId || !positionId || !startDate) {
      res.status(400).send({ message: 'guardId, stationId, positionId, and startDate are required' });
      return;
    }

    // If no rotationStyleId provided, use the station's default
    if (!rotationStyleId) {
      const station = await req.database.station.findByPk(stationId, { attributes: ['rotationStyleId'] });
      rotationStyleId = station?.rotationStyleId;
      if (!rotationStyleId) {
        res.status(400).send({ message: 'La estación no tiene un estilo de rotación configurado. Configúrela primero.' });
        return;
      }
    }

    const record = await req.database.guardAssignment.create({
      guardId,
      stationId,
      positionId,
      rotationStyleId,
      startDate,
      endDate: endDate || null,
      platoonOffset: parseInt(platoonOffset) || 0,
      isRelief: !!isRelief,
      status: 'active',
      tenantId,
      createdById: req.currentUser.id,
      updatedById: req.currentUser.id,
    });

    // Auto-generate shifts for this assignment
    try {
      const { generateShiftsForAssignment } = await import('../../services/shiftGenerationService');
      await generateShiftsForAssignment(req.database, record, tenantId, req.currentUser.id);
    } catch (genErr) {
      console.error('[guardAssignmentCreate] Shift generation error:', genErr);
    }

    await ApiResponseHandler.success(req, res, record);
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
// Auto-creates positions based on station scheduleType
export async function stationAutoPositions(req, res) {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const { stationId } = req.params;
    const tenantId = req.currentTenant.id;
    const data = req.body?.data || req.body || {};
    const scheduleType = data.scheduleType || '24h';
    const rotationStyleId = data.rotationStyleId || null;

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

    if (scheduleType === '24h') {
      positions.push(
        { name: 'Diurno', type: 'day', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Nocturno', type: 'night', startTime: '19:00', endTime: '07:00', guardsNeeded: 1, sortOrder: 1, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Sacafranco', type: 'relief', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 2, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    } else if (scheduleType === '12h-day') {
      positions.push(
        { name: 'Diurno', type: 'day', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Sacafranco', type: 'relief', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 1, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    } else if (scheduleType === '12h-night') {
      positions.push(
        { name: 'Nocturno', type: 'night', startTime: '19:00', endTime: '07:00', guardsNeeded: 1, sortOrder: 0, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Sacafranco', type: 'relief', startTime: '19:00', endTime: '07:00', guardsNeeded: 1, sortOrder: 1, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    } else {
      // Custom: create from provided times
      const customStart = data.startTime || '07:00';
      const customEnd = data.endTime || '19:00';
      positions.push(
        { name: 'Turno Principal', type: 'day', startTime: customStart, endTime: customEnd, guardsNeeded: 1, sortOrder: 0, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
        { name: 'Sacafranco', type: 'relief', startTime: customStart, endTime: customEnd, guardsNeeded: 1, sortOrder: 1, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      );
    }

    await req.database.stationPosition.bulkCreate(positions);
    const created = await req.database.stationPosition.findAll({
      where: { stationId, tenantId, deletedAt: null },
      order: [['sortOrder', 'ASC']],
    });

    await ApiResponseHandler.success(req, res, { rows: created, count: created.length });
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

    await ApiResponseHandler.success(req, res, {
      stations: stations.map((s: any) => s.get({ plain: true })),
      positions: positions.map((p: any) => p.get({ plain: true })),
      assignments: assignments.map((a: any) => a.get({ plain: true })),
      shifts: shifts.map((sh: any) => sh.get({ plain: true })),
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
      req.database.securityGuard.findAll({ where: { tenantId, deletedAt: null }, attributes: ['id', 'fullName', 'address', 'guardType', 'guardId'] }),
      req.database.rotationStyle.findAll({ where: { [Op.or]: [{ tenantId }, { tenantId: null, isSystem: true }] } }),
    ]);

    const assignedGuardIds = new Set(existingAssignments.map((a: any) => a.guardId));
    const availableGuards = guards.filter((g: any) => !assignedGuardIds.has(g.guardId));
    const titulares = availableGuards.filter((g: any) => g.guardType === 'titular');
    const sacafrancos = availableGuards.filter((g: any) => g.guardType === 'sacafranco');

    // Address-based proximity scoring
    const getAddressScore = (guardAddress: string, stationLat: string, stationLng: string) => {
      if (!guardAddress || !stationLat || !stationLng) return 50 + Math.random() * 50;
      const addr = (guardAddress || '').toLowerCase();
      const sLat = parseFloat(stationLat);
      const sLng = parseFloat(stationLng);
      let guardLat = -0.18, guardLng = -0.49;
      if (addr.includes('norte') || addr.includes('calderón') || addr.includes('carapungo')) { guardLat = -0.13; guardLng = -0.49; }
      else if (addr.includes('sur') || addr.includes('conocoto')) { guardLat = -0.27; guardLng = -0.52; }
      else if (addr.includes('cumbayá') || addr.includes('cumbaya') || addr.includes('tumbaco')) { guardLat = -0.19; guardLng = -0.43; }
      else if (addr.includes('valles') || addr.includes('chillos') || addr.includes('san rafael') || addr.includes('sangolquí')) { guardLat = -0.31; guardLng = -0.45; }
      else if (addr.includes('centro')) { guardLat = -0.22; guardLng = -0.51; }
      return Math.sqrt(Math.pow(sLat - guardLat, 2) + Math.pow(sLng - guardLng, 2));
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

    // Build demand: unfilled non-relief positions
    const demand: { stationId: string; positionId: string; type: string; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type === 'relief') continue;
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
      guardsLeft.sort((a: any, b: any) => getAddressScore(a.address, slot.station.latitud, slot.station.longitud) - getAddressScore(b.address, slot.station.latitud, slot.station.longitud));
      const best: any = guardsLeft.shift();
      newAssignments.push({
        guardId: best.guardId, stationId: slot.stationId, positionId: slot.positionId,
        rotationStyleId: slot.station.rotationStyleId, startDate: new Date().toISOString().slice(0, 10),
        platoonOffset: platoonCounter % 3, isRelief: false, status: 'active', tenantId, createdById: userId, updatedById: userId,
      });
      platoonCounter++;
    }

    // Assign sacafrancos to relief positions (reuse across stations)
    const reliefDemand: { stationId: string; positionId: string; station: any }[] = [];
    for (const station of stationsPlain) {
      const stPos = positionsByStation.get(station.id) || [];
      for (const pos of stPos) {
        if (pos.type !== 'relief') continue;
        if (!existingAssignments.some((a: any) => a.positionId === pos.id)) {
          reliefDemand.push({ stationId: station.id, positionId: pos.id, station });
        }
      }
    }

    let sacafLeft = [...sacafrancos];
    for (const slot of reliefDemand) {
      if (sacafLeft.length === 0) { sacafLeft = [...sacafrancos]; if (sacafLeft.length === 0) break; }
      sacafLeft.sort((a: any, b: any) => getAddressScore(a.address, slot.station.latitud, slot.station.longitud) - getAddressScore(b.address, slot.station.latitud, slot.station.longitud));
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
