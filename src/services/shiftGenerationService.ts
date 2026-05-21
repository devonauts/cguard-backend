/**
 * Shift Generation Service (v2 - Position-based architecture)
 * 
 * Key concepts:
 * - "Fijo" positions rotate D/N/L: e.g., 4-4-2 means 4 day, 4 night, 2 rest
 * - "Sacafranco" positions cover rest gaps of Fijo guards + have own rotation
 * - Rotation belongs to the STATION, not the individual guard
 * - platoonOffset staggers guards so they don't all rest the same day
 * - Yearly schedule generation for performance
 */

const GENERATION_DAYS = 365; // Generate 1 full year of shifts

interface AssignmentData {
  id: string;
  guardId: string;
  stationId: string;
  positionId: string;
  rotationStyleId: string;
  startDate: string;
  endDate?: string | null;
  platoonOffset: number;
  isRelief: boolean;
}

/**
 * Determine what a guard does on a given day based on rotation.
 * Returns: 'day' | 'night' | 'rest'
 */
function getRotationStatus(
  daysSinceStart: number,
  platoonOffset: number,
  dayShifts: number,
  nightShifts: number,
  restDays: number,
): 'day' | 'night' | 'rest' {
  const cycleLength = dayShifts + nightShifts + restDays;
  const adjustedDay = ((daysSinceStart - platoonOffset) % cycleLength + cycleLength) % cycleLength;
  if (adjustedDay < dayShifts) return 'day';
  if (adjustedDay < dayShifts + nightShifts) return 'night';
  return 'rest';
}

/**
 * Generate shifts for a single guard assignment.
 * For "fijo" positions: generates both D and N shifts following the rotation cycle.
 * For "sacafranco" positions: generates shifts on days when fijo guards rest + own rotation.
 */
export async function generateShiftsForAssignment(
  database: any,
  assignment: AssignmentData,
  tenantId: string,
  userId: string,
) {
  const { Op } = database.Sequelize;

  // Load rotation style (from station)
  const rotationStyle = await database.rotationStyle.findByPk(assignment.rotationStyleId);
  if (!rotationStyle) {
    console.error('[shiftGen] Rotation style not found:', assignment.rotationStyleId);
    return;
  }

  // Load position
  const position = await database.stationPosition.findByPk(assignment.positionId);
  if (!position) {
    console.error('[shiftGen] Position not found:', assignment.positionId);
    return;
  }

  const { dayShifts, nightShifts, restDays } = rotationStyle;

  // Determine generation window
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(assignment.startDate);
  const genStart = startDate > today ? startDate : today;
  const genEnd = assignment.endDate
    ? new Date(assignment.endDate)
    : new Date(today.getTime() + GENERATION_DAYS * 24 * 60 * 60 * 1000);

  // Delete existing generated shifts for this assignment in the future
  await database.shift.destroy({
    where: {
      guardAssignmentId: assignment.id,
      tenantId,
      startTime: { [Op.gte]: genStart },
    },
    force: true,
  });

  // Get station info for postSiteId
  const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId'] });
  const postSiteId = station?.postSiteId || null;

  // ─── SACAFRANCO LOGIC ──────────────────────────────────────────────────
  if (position.type === 'sacafranco' || assignment.isRelief) {
    const shifts = await generateSacafrancoShifts(
      database, assignment, position, rotationStyle, genStart, genEnd, tenantId, userId,
    );
    if (shifts.length > 0) {
      shifts.forEach(s => { s.postSiteId = postSiteId; });
      await database.shift.bulkCreate(shifts);
      console.log(`[shiftGen] Created ${shifts.length} SACAFRANCO shifts for assignment ${assignment.id}`);
    }
    return;
  }

  // ─── FIJO LOGIC ────────────────────────────────────────────────────────
  // Fijo positions rotate through D → N → L following the station's rotation style
  const shifts: any[] = [];
  const cursor = new Date(genStart);
  const assignmentStart = new Date(assignment.startDate);

  // Time windows: day shift uses position startTime/endTime, night is the inverse
  const dayStartTime = position.startTime || '07:00';
  const dayEndTime = position.endTime || '19:00';
  const nightStartTime = dayEndTime;
  const nightEndTime = dayStartTime;

  while (cursor <= genEnd) {
    const daysSinceStart = Math.floor((cursor.getTime() - assignmentStart.getTime()) / (24 * 60 * 60 * 1000));
    const status = getRotationStatus(daysSinceStart, assignment.platoonOffset, dayShifts, nightShifts, restDays);

    if (status !== 'rest') {
      const dateStr = cursor.toISOString().slice(0, 10);
      let startTime: Date;
      let endTime: Date;

      if (status === 'day') {
        startTime = new Date(`${dateStr}T${dayStartTime}:00`);
        endTime = new Date(`${dateStr}T${dayEndTime}:00`);
        if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
      } else {
        // night
        startTime = new Date(`${dateStr}T${nightStartTime}:00`);
        endTime = new Date(`${dateStr}T${nightEndTime}:00`);
        if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
      }

      shifts.push({
        guardId: assignment.guardId,
        stationId: assignment.stationId,
        positionId: assignment.positionId,
        guardAssignmentId: assignment.id,
        postSiteId,
        startTime,
        endTime,
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  if (shifts.length > 0) {
    await database.shift.bulkCreate(shifts);
    console.log(`[shiftGen] Created ${shifts.length} FIJO shifts for assignment ${assignment.id} (guard: ${assignment.guardId})`);
  }
}

/**
 * Generate sacafranco shifts.
 * Sacafrancos follow their OWN rotation cycle (D/N/L) independently.
 * On work days (D or N), they work — covering fijo rest gaps is implicit.
 * On rest days (L), they don't work.
 */
async function generateSacafrancoShifts(
  database: any,
  assignment: AssignmentData,
  position: any,
  rotationStyle: any,
  genStart: Date,
  genEnd: Date,
  tenantId: string,
  userId: string,
): Promise<any[]> {
  const { dayShifts, nightShifts, restDays } = rotationStyle;
  const cycleLength = dayShifts + nightShifts + restDays;
  if (cycleLength === 0) return [];

  const shifts: any[] = [];
  const cursor = new Date(genStart);
  const assignmentStart = new Date(assignment.startDate);

  // Time windows
  const dayStartTime = position.startTime || '07:00';
  const dayEndTime = position.endTime || '19:00';
  const nightStartTime = dayEndTime;
  const nightEndTime = dayStartTime;

  while (cursor <= genEnd) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const daysSinceSfStart = Math.floor((cursor.getTime() - assignmentStart.getTime()) / (24 * 60 * 60 * 1000));

    if (daysSinceSfStart >= 0) {
      // Check sacafranco's own rotation
      const sfStatus = getRotationStatus(daysSinceSfStart, assignment.platoonOffset, dayShifts, nightShifts, restDays);

      if (sfStatus !== 'rest') {
        // Sacafranco works on this day — generate shift
        let startTime: Date;
        let endTime: Date;

        if (sfStatus === 'night') {
          startTime = new Date(`${dateStr}T${nightStartTime}:00`);
          endTime = new Date(`${dateStr}T${nightEndTime}:00`);
          if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
        } else {
          startTime = new Date(`${dateStr}T${dayStartTime}:00`);
          endTime = new Date(`${dateStr}T${dayEndTime}:00`);
          if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
        }

        shifts.push({
          guardId: assignment.guardId,
          stationId: assignment.stationId,
          positionId: assignment.positionId,
          guardAssignmentId: assignment.id,
          postSiteId: null,
          startTime,
          endTime,
          tenantId,
          createdById: userId,
          updatedById: userId,
        });
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return shifts;
}

/**
 * Generate the full year schedule for ALL positions at a station.
 * Called when a station is configured with a rotation style.
 * Processes assignments in batches for async performance.
 */
export async function generateYearlyScheduleForStation(
  database: any,
  stationId: string,
  tenantId: string,
  userId: string,
) {
  const assignments = await database.guardAssignment.findAll({
    where: { stationId, tenantId, status: 'active', deletedAt: null },
  });

  const batchSize = 5;
  for (let i = 0; i < assignments.length; i += batchSize) {
    const batch = assignments.slice(i, i + batchSize);
    await Promise.all(
      batch.map((assignment: any) =>
        generateShiftsForAssignment(database, assignment.get({ plain: true }), tenantId, userId),
      ),
    );
  }

  console.log(`[shiftGen] Generated yearly schedule for station ${stationId} (${assignments.length} assignments)`);
  return { assignmentsProcessed: assignments.length };
}

/**
 * Regenerate shifts for all active assignments of a station.
 */
export async function regenerateStationShifts(
  database: any,
  stationId: string,
  tenantId: string,
  userId: string,
) {
  return generateYearlyScheduleForStation(database, stationId, tenantId, userId);
}

/**
 * Optimize sacafranco assignments across ALL stations.
 * 
 * Algorithm:
 * 1. Find all configured stations with fijo assignments
 * 2. Compute rest-day demand per station (which days need coverage)
 * 3. Find all sacafranco guards (by guardType or existing sacafranco assignments)
 * 4. Auto-assign each sacafranco to cover multiple stations
 * 5. Generate shifts: sacafranco's own rotation determines work/rest,
 *    on work days they cover whichever station has a gap
 * 6. Result: each sacafranco has a complete schedule showing where they go each day
 */
export async function optimizeSacafrancos(
  database: any,
  tenantId: string,
  userId: string,
  sacafrancoRotationStyleId?: string,
): Promise<{ message: string; details: any }> {
  const { Op } = database.Sequelize;

  // 1. Get all stations with rotation configured
  const stations = await database.station.findAll({
    where: { tenantId, deletedAt: null, rotationStyleId: { [Op.ne]: null } },
    attributes: ['id', 'stationName', 'rotationStyleId'],
  });

  if (stations.length === 0) {
    return { message: 'No hay estaciones configuradas', details: { totalStations: 0 } };
  }

  // 2. Get all fijo assignments to compute rest days
  const fijoAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: false },
    include: [
      { model: database.stationPosition, as: 'position', attributes: ['type', 'stationId'], where: { type: 'fijo' } },
      { model: database.rotationStyle, as: 'rotationStyle', attributes: ['dayShifts', 'nightShifts', 'restDays'] },
    ],
  });

  // 3. Find all sacafranco positions across stations
  const sacafrancoPositions = await database.stationPosition.findAll({
    where: { tenantId, deletedAt: null, type: 'sacafranco' },
    attributes: ['id', 'stationId', 'startTime', 'endTime'],
  });

  // 4. Find sacafranco guards (from securityGuard table or existing relief assignments)
  const existingSfAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
    include: [{ model: database.user, as: 'guard', attributes: ['id', 'firstName', 'lastName'] }],
  });

  // Get a default sacafranco rotation style
  let sfRotationStyleId = sacafrancoRotationStyleId;
  if (!sfRotationStyleId && existingSfAssignments.length > 0) {
    sfRotationStyleId = existingSfAssignments[0].rotationStyleId;
  }
  if (!sfRotationStyleId) {
    // Default to 6-1 for sacafrancos (6 work, 1 rest)
    const rot61 = await database.rotationStyle.findOne({ where: { name: '6-1', isSystem: true } });
    sfRotationStyleId = rot61?.id;
    if (!sfRotationStyleId) {
      const anyRot = await database.rotationStyle.findOne({ where: { isSystem: true } });
      sfRotationStyleId = anyRot?.id;
    }
  }

  // 5. For each sacafranco assignment: ensure they're linked to ALL stations that need coverage
  // First, compute which stations have rest gaps (have fijo assignments)
  const stationsWithFijos = new Set(fijoAssignments.map((a: any) => a.position?.stationId || a.stationId));
  const stationsNeedingCoverage = stations.filter((s: any) => stationsWithFijos.has(s.id));

  // Ensure each station with fijos has a sacafranco position
  for (const station of stationsNeedingCoverage) {
    const hasSfPos = sacafrancoPositions.some((p: any) => p.stationId === station.id);
    if (!hasSfPos) {
      // Create sacafranco position for this station
      await database.stationPosition.create({
        name: 'Sacafranco',
        type: 'sacafranco',
        startTime: '07:00',
        endTime: '19:00',
        guardsNeeded: 1,
        sortOrder: 99,
        platoonOffset: 0,
        stationId: station.id,
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
    }
  }

  // Reload sacafranco positions after potential creation
  const allSfPositions = await database.stationPosition.findAll({
    where: { tenantId, deletedAt: null, type: 'sacafranco' },
    attributes: ['id', 'stationId', 'startTime', 'endTime'],
  });

  // 6. For each existing sacafranco guard, ensure they have an assignment at each station needing coverage
  const sfGuardIds = [...new Set(existingSfAssignments.map((a: any) => a.guardId))];
  let assignmentsCreated = 0;

  for (const guardId of sfGuardIds) {
    const guardAssignments = existingSfAssignments.filter((a: any) => a.guardId === guardId);
    const guardStations = new Set(guardAssignments.map((a: any) => a.stationId));

    for (const station of stationsNeedingCoverage) {
      if (guardStations.has(station.id)) continue; // Already assigned here

      const sfPos = allSfPositions.find((p: any) => p.stationId === station.id);
      if (!sfPos) continue;

      // Create assignment for this sacafranco at this station
      await database.guardAssignment.create({
        guardId,
        stationId: station.id,
        positionId: sfPos.id,
        rotationStyleId: sfRotationStyleId,
        startDate: new Date().toISOString().slice(0, 10),
        platoonOffset: 0,
        isRelief: true,
        status: 'active',
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
      assignmentsCreated++;
    }
  }

  // 7. Update all sacafranco assignments to use the specified rotation style
  if (sfRotationStyleId) {
    await database.guardAssignment.update(
      { rotationStyleId: sfRotationStyleId },
      { where: { tenantId, status: 'active', deletedAt: null, isRelief: true } },
    );
  }

  // 8. Regenerate shifts for ALL sacafranco assignments
  const allSfAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
  });

  let regenerated = 0;
  const batchSize = 5;
  for (let i = 0; i < allSfAssignments.length; i += batchSize) {
    const batch = allSfAssignments.slice(i, i + batchSize);
    await Promise.all(
      batch.map((asgn: any) =>
        generateShiftsForAssignment(database, asgn.get({ plain: true }), tenantId, userId),
      ),
    );
    regenerated += batch.length;
  }

  return {
    message: `Sacafrancos optimizados: ${regenerated} asignaciones procesadas, ${assignmentsCreated} nuevas creadas`,
    details: {
      totalStations: stationsNeedingCoverage.length,
      sacafrancosProcessed: regenerated,
      newAssignments: assignmentsCreated,
      rotationStyleId: sfRotationStyleId,
    },
  };
}
