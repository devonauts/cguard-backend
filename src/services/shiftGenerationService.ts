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

  // Generate shifts day by day
  const shifts: any[] = [];
  const cursor = new Date(genStart);
  const assignmentStart = new Date(assignment.startDate);

  while (cursor <= genEnd) {
    // Calculate day index within the rotation cycle
    const daysSinceStart = Math.floor((cursor.getTime() - assignmentStart.getTime()) / (24 * 60 * 60 * 1000));
    const adjustedDay = ((daysSinceStart - assignment.platoonOffset) % cycleLength + cycleLength) % cycleLength;

    let positionType: 'day' | 'night' | null = null;

    if (adjustedDay < dayShifts) {
      // Day shift phase
      positionType = 'day';
    } else if (adjustedDay < dayShifts + nightShifts) {
      // Night shift phase
      positionType = 'night';
    }
    // else: rest day — no shift

    if (positionType) {
      // For relief guards: they work on any phase matching the position type
      // For regular guards: they work on their designated position type
      const shouldWork = assignment.isRelief || position.type === positionType || position.type === 'relief';

      if (shouldWork) {
        const dateStr = cursor.toISOString().slice(0, 10);
        let startTime: Date;
        let endTime: Date;

        if (positionType === 'night' && position.type !== 'day') {
          // Night shift: use position times (e.g., 19:00 - 07:00 next day)
          startTime = new Date(`${dateStr}T${position.startTime}:00`);
          endTime = new Date(`${dateStr}T${position.endTime}:00`);
          if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
        } else {
          // Day shift: use position times
          startTime = new Date(`${dateStr}T${position.startTime}:00`);
          endTime = new Date(`${dateStr}T${position.endTime}:00`);
          if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
        }

        shifts.push({
          guardId: assignment.guardId,
          stationId: assignment.stationId,
          positionId: assignment.positionId,
          guardAssignmentId: assignment.id,
          postSiteId: null, // Will be set below
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

  // Get the station's postSiteId
  const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId'] });
  const postSiteId = station?.postSiteId || null;

  // Set postSiteId on all shifts
  shifts.forEach(s => { s.postSiteId = postSiteId; });

  // Bulk create
  await database.shift.bulkCreate(shifts);
  console.log(`[shiftGen] Created ${shifts.length} shifts for assignment ${assignment.id} (guard: ${assignment.guardId})`);
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
