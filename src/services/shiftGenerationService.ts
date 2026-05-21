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
 * Sacafrancos work on days when any fijo guard at their station is resting,
 * but they also follow their own rotation cycle for rest days.
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

  // Find all active fijo assignments for this station
  const fijoAssignments = await database.guardAssignment.findAll({
    where: {
      stationId: assignment.stationId,
      tenantId,
      status: 'active',
      deletedAt: null,
      id: { [database.Sequelize.Op.ne]: assignment.id },
      isRelief: false,
    },
    include: [
      { model: database.stationPosition, as: 'position', attributes: ['type'] },
      { model: database.rotationStyle, as: 'rotationStyle', attributes: ['dayShifts', 'nightShifts', 'restDays'] },
    ],
  });

  // Filter to only fijo positions
  const mainAssignments = fijoAssignments.filter((a: any) => {
    const pos = a.position || a.get?.('position');
    return pos && pos.type === 'fijo';
  });

  if (mainAssignments.length === 0) {
    console.log(`[shiftGen] No fijo guards to cover for sacafranco assignment ${assignment.id}`);
    return [];
  }

  const shifts: any[] = [];
  const cursor = new Date(genStart);
  const assignmentStart = new Date(assignment.startDate);

  while (cursor <= genEnd) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const daysSinceSfStart = Math.floor((cursor.getTime() - assignmentStart.getTime()) / (24 * 60 * 60 * 1000));

    // Check sacafranco's own rotation: if they're on rest, skip
    const sfStatus = getRotationStatus(daysSinceSfStart, assignment.platoonOffset, dayShifts, nightShifts, restDays);
    if (sfStatus === 'rest') {
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }

    // Check if ANY fijo guard at this station is resting today
    let someoneResting = false;

    for (const mainAssign of mainAssignments) {
      const mainRot = mainAssign.rotationStyle || mainAssign.get?.('rotationStyle');
      if (!mainRot) continue;

      const mainStart = new Date(mainAssign.startDate);
      const daysSinceMainStart = Math.floor((cursor.getTime() - mainStart.getTime()) / (24 * 60 * 60 * 1000));
      if (daysSinceMainStart < 0) continue;

      const mainStatus = getRotationStatus(
        daysSinceMainStart,
        mainAssign.platoonOffset || 0,
        mainRot.dayShifts,
        mainRot.nightShifts,
        mainRot.restDays,
      );

      if (mainStatus === 'rest') {
        someoneResting = true;
        break;
      }
    }

    if (someoneResting) {
      // Sacafranco covers with shift type based on their own rotation status
      let startTime: Date;
      let endTime: Date;

      if (sfStatus === 'night') {
        const nightStart = position.endTime || '19:00';
        const nightEnd = position.startTime || '07:00';
        startTime = new Date(`${dateStr}T${nightStart}:00`);
        endTime = new Date(`${dateStr}T${nightEnd}:00`);
        if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
      } else {
        startTime = new Date(`${dateStr}T${position.startTime}:00`);
        endTime = new Date(`${dateStr}T${position.endTime}:00`);
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
 * Optimize sacafranco assignments across all stations.
 * Regenerates all sacafranco shifts to ensure optimal coverage.
 */
export async function optimizeSacafrancos(
  database: any,
  tenantId: string,
  userId: string,
): Promise<{ message: string; details: any }> {
  const { Op } = database.Sequelize;

  const stations = await database.station.findAll({
    where: { tenantId, deletedAt: null, rotationStyleId: { [Op.ne]: null } },
    attributes: ['id', 'stationName'],
  });

  const sacafrancoAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
  });

  let regenerated = 0;
  for (const asgn of sacafrancoAssignments) {
    await generateShiftsForAssignment(database, asgn.get({ plain: true }), tenantId, userId);
    regenerated++;
  }

  return {
    message: `Sacafrancos optimized: ${regenerated} assignments regenerated`,
    details: {
      totalStations: stations.length,
      sacafrancosProcessed: regenerated,
    },
  };
}
