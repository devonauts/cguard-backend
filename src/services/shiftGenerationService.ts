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
 * Calculate staffing requirements for the entire tenant.
 * Returns: how many fijos per station, how many total sacafrancos needed.
 * 
 * Algorithm:
 * 1. For each station, count fijo positions (these determine rest-day demand)
 * 2. Compute the LCM of all station rotation cycles to get a "super-cycle"
 * 3. For each day in the super-cycle, count how many stations have at least one fijo resting
 * 4. The max concurrent rest gaps = peak demand for sacafrancos on any given day
 * 5. Given the SF rotation (work days per cycle), calculate:
 *    sacafrancos_needed = ceil(peak_demand * sf_cycle / sf_work_days)
 */
export function calculateStaffingNeeds(
  stationConfigs: { stationId: string; stationName: string; fijoPositions: { platoonOffset: number; dayShifts: number; nightShifts: number; restDays: number }[] }[],
  sfRotation: { dayShifts: number; nightShifts: number; restDays: number },
): { fijosNeeded: number; sacafrancosNeeded: number; peakDemand: number; dailyDemand: number[]; stationDetails: { stationId: string; stationName: string; fijos: number }[] } {
  if (stationConfigs.length === 0) {
    return { fijosNeeded: 0, sacafrancosNeeded: 0, peakDemand: 0, dailyDemand: [], stationDetails: [] };
  }

  // Calculate total fijos across all stations
  const fijosNeeded = stationConfigs.reduce((sum, s) => sum + s.fijoPositions.length, 0);

  // Get all unique cycle lengths and compute LCM for a "super-cycle"
  const cycleLengths = new Set<number>();
  stationConfigs.forEach(s => s.fijoPositions.forEach(f => cycleLengths.add(f.dayShifts + f.nightShifts + f.restDays)));
  const sfCycle = sfRotation.dayShifts + sfRotation.nightShifts + sfRotation.restDays;
  cycleLengths.add(sfCycle);

  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);
  let superCycle = 1;
  cycleLengths.forEach(c => { if (c > 0) superCycle = lcm(superCycle, c); });
  // Cap to prevent huge cycles
  if (superCycle > 365) superCycle = Math.max(...Array.from(cycleLengths)) * 2;

  // For each day in the super-cycle, count stations needing coverage
  const dailyDemand: number[] = [];
  for (let day = 0; day < superCycle; day++) {
    let stationsNeedingCoverage = 0;
    for (const station of stationConfigs) {
      // Check if ANY fijo at this station is resting on this day
      let anyResting = false;
      for (const fijo of station.fijoPositions) {
        const cycle = fijo.dayShifts + fijo.nightShifts + fijo.restDays;
        if (cycle === 0) continue;
        const adj = ((day - fijo.platoonOffset) % cycle + cycle) % cycle;
        if (adj >= fijo.dayShifts + fijo.nightShifts) {
          anyResting = true;
          break;
        }
      }
      if (anyResting) stationsNeedingCoverage++;
    }
    dailyDemand.push(stationsNeedingCoverage);
  }

  const peakDemand = Math.max(...dailyDemand, 0);

  // Calculate how many SFs needed: each SF works (sfWorkDays/sfCycle) fraction of time
  const sfWorkDays = sfRotation.dayShifts + sfRotation.nightShifts;
  let sacafrancosNeeded = 0;
  if (sfWorkDays > 0 && sfCycle > 0) {
    // Average demand across the cycle
    const avgDemand = dailyDemand.reduce((s, d) => s + d, 0) / superCycle;
    // Each SF can cover (sfWorkDays/sfCycle) stations per day on average
    // But we need to handle peak: use ceiling of peak * cycle / workDays
    sacafrancosNeeded = Math.ceil(peakDemand * sfCycle / sfWorkDays);
    // Also check average-based calculation and take the larger
    const avgBased = Math.ceil(avgDemand * sfCycle / sfWorkDays);
    sacafrancosNeeded = Math.max(sacafrancosNeeded, avgBased);
  }

  const stationDetails = stationConfigs.map(s => ({
    stationId: s.stationId,
    stationName: s.stationName,
    fijos: s.fijoPositions.length,
  }));

  return { fijosNeeded, sacafrancosNeeded, peakDemand, dailyDemand, stationDetails };
}

/**
 * Optimize sacafranco assignments across ALL stations.
 * 
 * New algorithm:
 * 1. Calculate how many SFs are needed (staffing calculator)
 * 2. Create numbered SF positions: "SF 1", "SF 2", etc.
 * 3. Each SF position is assigned to cover specific stations — rotated so each SF
 *    covers the minimum stations needed to fill their work days
 * 4. Generate shifts for each SF showing which station they cover each day
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
    attributes: ['id', 'stationName', 'rotationStyleId', 'scheduleType'],
  });

  if (stations.length === 0) {
    return { message: 'No hay estaciones configuradas', details: { totalStations: 0, sacafrancosNeeded: 0 } };
  }

  // 2. Get all fijo positions
  const fijoPositions = await database.stationPosition.findAll({
    where: { tenantId, deletedAt: null, type: 'fijo' },
    attributes: ['id', 'stationId', 'platoonOffset', 'sortOrder'],
  });

  // 3. Get rotation details for each station
  const rotationCache = new Map<string, any>();
  for (const station of stations) {
    if (!rotationCache.has(station.rotationStyleId)) {
      const rot = await database.rotationStyle.findByPk(station.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
      if (rot) rotationCache.set(station.rotationStyleId, rot);
    }
  }

  // 4. OPTIMIZE: Reassign platoonOffsets to stagger rest days globally
  // Group fijos by their cycle length, then spread offsets evenly within each group
  const fijosByStation = new Map<string, any[]>();
  for (const fijo of fijoPositions) {
    if (!fijosByStation.has(fijo.stationId)) fijosByStation.set(fijo.stationId, []);
    fijosByStation.get(fijo.stationId)!.push(fijo);
  }

  // For offset optimization: assign offsets so that across ALL stations with the same cycle,
  // rest days are spread as evenly as possible
  const byCycle = new Map<number, { fijo: any; stationId: string; rot: any }[]>();
  for (const station of stations) {
    const rot = rotationCache.get(station.rotationStyleId);
    if (!rot) continue;
    const cycle = rot.dayShifts + rot.nightShifts + rot.restDays;
    if (!byCycle.has(cycle)) byCycle.set(cycle, []);
    const stationFijos = fijosByStation.get(station.id) || [];
    for (const fijo of stationFijos) {
      byCycle.get(cycle)!.push({ fijo, stationId: station.id, rot });
    }
  }

  // Assign optimal offsets: spread evenly within each cycle group
  const offsetUpdates: { id: string; platoonOffset: number }[] = [];
  for (const [cycle, fijos] of byCycle.entries()) {
    // Spread offsets: assign 0, 1, 2, ... modulo cycle
    // This ensures at most ceil(fijos.length / cycle) guards rest on any given day
    for (let i = 0; i < fijos.length; i++) {
      const newOffset = i % cycle;
      if (fijos[i].fijo.platoonOffset !== newOffset) {
        offsetUpdates.push({ id: fijos[i].fijo.id, platoonOffset: newOffset });
      }
    }
  }

  // Apply offset updates
  for (const update of offsetUpdates) {
    await database.stationPosition.update(
      { platoonOffset: update.platoonOffset },
      { where: { id: update.id, tenantId } }
    );
    // Also update any active assignment for this position
    await database.guardAssignment.update(
      { platoonOffset: update.platoonOffset },
      { where: { positionId: update.id, tenantId, status: 'active', deletedAt: null } }
    );
  }

  // 5. Build station configs with NEW optimized offsets
  const stationConfigs: any[] = [];
  for (const station of stations) {
    const rot = rotationCache.get(station.rotationStyleId);
    if (!rot) continue;
    const stationFijos = fijosByStation.get(station.id) || [];
    // Recalculate offsets from the byCycle assignment
    const cycle = rot.dayShifts + rot.nightShifts + rot.restDays;
    const cycleGroup = byCycle.get(cycle) || [];
    const thisStationInGroup = cycleGroup.filter(f => f.stationId === station.id);

    stationConfigs.push({
      stationId: station.id,
      stationName: station.stationName,
      fijoPositions: thisStationInGroup.map((f, idx) => {
        const groupIdx = cycleGroup.indexOf(f);
        return {
          platoonOffset: groupIdx % cycle,
          dayShifts: rot.dayShifts,
          nightShifts: rot.nightShifts,
          restDays: rot.restDays,
        };
      }),
    });
  }

  // 6. Get or determine SF rotation style — prefer 6-1 (best work ratio: 6/7 = 86%)
  let sfRotationStyleId = sacafrancoRotationStyleId;
  if (!sfRotationStyleId) {
    // Prefer 6-1 for maximum coverage efficiency
    const rot61 = await database.rotationStyle.findOne({ where: { name: '6-1', isSystem: true } });
    sfRotationStyleId = rot61?.id;
    if (!sfRotationStyleId) {
      const anyRot = await database.rotationStyle.findOne({ where: { isSystem: true }, order: [['restDays', 'ASC']] });
      sfRotationStyleId = anyRot?.id;
    }
  }

  const sfRotation = await database.rotationStyle.findByPk(sfRotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
  if (!sfRotation) {
    return { message: 'No se encontró estilo de rotación para sacafrancos', details: {} };
  }

  // 7. Calculate staffing needs with optimized offsets
  const staffing = calculateStaffingNeeds(stationConfigs, {
    dayShifts: sfRotation.dayShifts,
    nightShifts: sfRotation.nightShifts,
    restDays: sfRotation.restDays,
  });

  const numSfNeeded = staffing.sacafrancosNeeded;

  // 8. Remove old sacafranco positions and their assignments/shifts
  const oldSfPositions = await database.stationPosition.findAll({
    where: { tenantId, deletedAt: null, type: 'sacafranco' },
    attributes: ['id'],
  });
  const oldSfPosIds = oldSfPositions.map((p: any) => p.id);

  if (oldSfPosIds.length > 0) {
    await database.shift.destroy({ where: { positionId: oldSfPosIds, tenantId }, force: true });
    await database.guardAssignment.destroy({ where: { positionId: oldSfPosIds, tenantId }, force: true });
    await database.stationPosition.destroy({ where: { id: oldSfPosIds, tenantId }, force: true });
  }

  // 9. Create SF positions (minimal count)
  const sfCycle = sfRotation.dayShifts + sfRotation.nightShifts + sfRotation.restDays;
  const stationsWithFijos = stationConfigs.filter(s => s.fijoPositions.length > 0);

  if (stationsWithFijos.length === 0 || numSfNeeded === 0) {
    return {
      message: `No se necesitan sacafrancos (${stationsWithFijos.length} estaciones sin gaps)`,
      details: { totalStations: stations.length, sacafrancosNeeded: 0, fijosNeeded: staffing.fijosNeeded, offsetsOptimized: offsetUpdates.length },
    };
  }

  const primaryStationId = stationsWithFijos[0].stationId;
  const newSfPositions: any[] = [];
  for (let i = 0; i < numSfNeeded; i++) {
    newSfPositions.push({
      name: `SF ${i + 1}`,
      type: 'sacafranco',
      startTime: '07:00',
      endTime: '19:00',
      guardsNeeded: 1,
      sortOrder: 100 + i,
      platoonOffset: i % sfCycle, // Stagger SF rest days
      stationId: primaryStationId,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });
  }
  await database.stationPosition.bulkCreate(newSfPositions);

  return {
    message: `Optimizado: ${numSfNeeded} sacafrancos para ${stationsWithFijos.length} estaciones (offsets ajustados: ${offsetUpdates.length})`,
    details: {
      totalStations: stationsWithFijos.length,
      sacafrancosNeeded: numSfNeeded,
      fijosNeeded: staffing.fijosNeeded,
      peakDemand: staffing.peakDemand,
      offsetsOptimized: offsetUpdates.length,
      rotationStyleId: sfRotationStyleId,
    },
  };
}
