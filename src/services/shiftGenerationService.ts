/**
 * Shift Generation Service
 * 
 * Generates shift records based on guard assignments and rotation styles.
 * Handles:
 * - Day/night rotation patterns (e.g., 3-3-2: 3 days, 3 nights, 2 rest)
 * - Simple work/rest patterns (e.g., 5-2: 5 work, 2 rest)
 * - Platoon offsets for staggered coverage
 * - Relief (sacafranco) guards that fill rest-day gaps across stations
 */

const GENERATION_WEEKS = 6; // Generate 6 weeks of shifts ahead

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
 * Generate shifts for a single guard assignment.
 * Called when a new assignment is created or when regenerating.
 */
export async function generateShiftsForAssignment(
  database: any,
  assignment: AssignmentData,
  tenantId: string,
  userId: string,
) {
  const { Op } = database.Sequelize;

  // Load rotation style
  const rotationStyle = await database.rotationStyle.findByPk(assignment.rotationStyleId);
  if (!rotationStyle) {
    console.error('[shiftGen] Rotation style not found:', assignment.rotationStyleId);
    return;
  }

  // Load position to get time windows
  const position = await database.stationPosition.findByPk(assignment.positionId);
  if (!position) {
    console.error('[shiftGen] Position not found:', assignment.positionId);
    return;
  }

  const { dayShifts, nightShifts, restDays } = rotationStyle;
  const cycleLength = dayShifts + nightShifts + restDays;

  // Determine generation window
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(assignment.startDate);
  const genStart = startDate > today ? startDate : today;
  const genEnd = assignment.endDate
    ? new Date(assignment.endDate)
    : new Date(today.getTime() + GENERATION_WEEKS * 7 * 24 * 60 * 60 * 1000);

  // Delete existing generated shifts for this assignment in the future
  await database.shift.destroy({
    where: {
      guardAssignmentId: assignment.id,
      tenantId,
      startTime: { [Op.gte]: genStart },
    },
    force: true,
  });

  // ─── RELIEF (SACAFRANCO) LOGIC ─────────────────────────────────────────
  // Relief guards only work on days when the main guards at this station are resting.
  if (assignment.isRelief || position.type === 'relief') {
    const shifts = await generateReliefShifts(database, assignment, position, rotationStyle, genStart, genEnd, tenantId, userId);
    if (shifts.length > 0) {
      const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId'] });
      const postSiteId = station?.postSiteId || null;
      shifts.forEach(s => { s.postSiteId = postSiteId; });
      await database.shift.bulkCreate(shifts);
      console.log(`[shiftGen] Created ${shifts.length} RELIEF shifts for assignment ${assignment.id}`);
    }
    return;
  }

  // ─── REGULAR GUARD LOGIC ───────────────────────────────────────────────
  const shifts: any[] = [];
  const cursor = new Date(genStart);
  const assignmentStart = new Date(assignment.startDate);

  while (cursor <= genEnd) {
    const daysSinceStart = Math.floor((cursor.getTime() - assignmentStart.getTime()) / (24 * 60 * 60 * 1000));
    const adjustedDay = ((daysSinceStart - assignment.platoonOffset) % cycleLength + cycleLength) % cycleLength;

    let positionType: 'day' | 'night' | null = null;

    if (adjustedDay < dayShifts) {
      positionType = 'day';
    } else if (adjustedDay < dayShifts + nightShifts) {
      positionType = 'night';
    }

    if (positionType) {
      const shouldWork = position.type === positionType || position.type === 'day' && positionType === 'day' || position.type === 'night' && positionType === 'night';

      if (shouldWork) {
        const dateStr = cursor.toISOString().slice(0, 10);
        let startTime: Date;
        let endTime: Date;

        if (positionType === 'night') {
          startTime = new Date(`${dateStr}T${position.startTime}:00`);
          endTime = new Date(`${dateStr}T${position.endTime}:00`);
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
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  if (shifts.length === 0) return;

  const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId'] });
  const postSiteId = station?.postSiteId || null;
  shifts.forEach(s => { s.postSiteId = postSiteId; });

  await database.shift.bulkCreate(shifts);
  console.log(`[shiftGen] Created ${shifts.length} shifts for assignment ${assignment.id} (guard: ${assignment.guardId})`);
}

/**
 * Generate relief shifts: only on days when the main guards at the same station are resting.
 * Finds all non-relief assignments for the station, calculates their rest days,
 * and generates shifts for the sacafranco on those rest days.
 */
async function generateReliefShifts(
  database: any,
  assignment: AssignmentData,
  position: any,
  rotationStyle: any,
  genStart: Date,
  genEnd: Date,
  tenantId: string,
  userId: string,
): Promise<any[]> {
  // Find all active non-relief assignments for this station
  const mainAssignments = await database.guardAssignment.findAll({
    where: {
      stationId: assignment.stationId,
      tenantId,
      status: 'active',
      deletedAt: null,
      id: { [database.Sequelize.Op.ne]: assignment.id },
    },
    include: [
      { model: database.stationPosition, as: 'position', attributes: ['type'] },
      { model: database.rotationStyle, as: 'rotationStyle', attributes: ['dayShifts', 'nightShifts', 'restDays'] },
    ],
  });

  // Filter to only main (non-relief) assignments
  const nonReliefAssignments = mainAssignments.filter((a: any) => {
    const pos = a.position || a.get?.('position');
    return pos && pos.type !== 'relief';
  });

  if (nonReliefAssignments.length === 0) {
    // No main guards assigned yet — nothing to cover
    console.log(`[shiftGen] No main guards to cover for relief assignment ${assignment.id}`);
    return [];
  }

  // For each day in the window, check if ANY main guard is resting
  const shifts: any[] = [];
  const cursor = new Date(genStart);

  while (cursor <= genEnd) {
    const dateStr = cursor.toISOString().slice(0, 10);

    // Check each main assignment - if ANY has a rest day, the sacafranco covers
    for (const mainAssign of nonReliefAssignments) {
      const mainRot = mainAssign.rotationStyle || mainAssign.get?.('rotationStyle');
      if (!mainRot) continue;

      const mainCycle = mainRot.dayShifts + mainRot.nightShifts + mainRot.restDays;
      const mainStart = new Date(mainAssign.startDate);
      const daysSinceMainStart = Math.floor((cursor.getTime() - mainStart.getTime()) / (24 * 60 * 60 * 1000));
      const mainAdjustedDay = ((daysSinceMainStart - (mainAssign.platoonOffset || 0)) % mainCycle + mainCycle) % mainCycle;

      // This main guard is resting today
      const isRestDay = mainAdjustedDay >= (mainRot.dayShifts + mainRot.nightShifts);

      if (isRestDay) {
        // Determine which position type the main guard would have worked
        // Use the relief position's time window
        const startTime = new Date(`${dateStr}T${position.startTime}:00`);
        const endTime = new Date(`${dateStr}T${position.endTime}:00`);
        if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);

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
        break; // Only one shift per day for the relief guard
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return shifts;
}

/**
 * Regenerate shifts for all active assignments of a station.
 * Used when the rotation style or positions change.
 */
export async function regenerateStationShifts(
  database: any,
  stationId: string,
  tenantId: string,
  userId: string,
) {
  const assignments = await database.guardAssignment.findAll({
    where: { stationId, tenantId, status: 'active', deletedAt: null },
  });

  for (const assignment of assignments) {
    await generateShiftsForAssignment(database, assignment.get({ plain: true }), tenantId, userId);
  }

  console.log(`[shiftGen] Regenerated shifts for ${assignments.length} assignments on station ${stationId}`);
}
