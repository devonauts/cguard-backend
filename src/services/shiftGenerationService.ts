/**
 * Shift Generation Service (v2 - Position-based architecture)
 * 
 * Key concepts:
 * - "Fijo" positions rotate D/N/L: e.g., 4-4-2 means 4 day, 4 night, 2 rest
 * - "Sacafranco" positions cover rest gaps of Fijo guards + have own rotation
 * - Rotation belongs to the STATION, not the individual guard
 * - platoonOffset determines WHEN in the cycle rest days fall (relative to Jan 1 epoch)
 * - Stations are sequenced so rest days form a chain: Station 1 rests Mon-Tue, Station 2 Wed-Thu, etc.
 * - This allows sacafrancos to work consecutive days covering different stations
 */

import { wallClockToUtc } from '../lib/tenantTime';

const GENERATION_DAYS = 365; // Generate 1 full year of shifts

/** Load the tenant's timezone (single source of truth for wall-clock times). */
async function tenantTz(database: any, tenantId: string): Promise<string> {
  try {
    const t = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    return (t && t.timezone) || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface AssignmentData {
  id: string;
  guardId: string;
  stationId: string;
  positionId: string | null;
  rotationStyleId: string | null;
  startDate: string;
  endDate?: string | null;
  platoonOffset: number;
  isRelief: boolean;
  kind?: 'rotation' | 'adhoc';
  startTime?: string | null; // HH:mm, adhoc only
  endTime?: string | null;   // HH:mm, adhoc only
}

/**
 * THE rotation epoch — day-zero for every rotation calculation, so platoonOffset
 * means the same thing in the generator, the staffing/gap analyzers, and the
 * frontend grid. Exported as the single source of truth (Phase 3): all consumers
 * MUST use this rather than re-deriving an epoch, or rest-day patterns disagree.
 *
 * Currently anchored to Jan 1 of the reference year. Known caveat: a fixed anchor
 * (e.g. 2024-01-01) would avoid the year-boundary realignment, but switching now
 * would reshift every existing rotation, so that migration is deferred.
 */
export function getGlobalEpoch(referenceDate?: Date): Date {
  const ref = referenceDate || new Date();
  return new Date(ref.getFullYear(), 0, 1);
}

/**
 * Determine what a guard does on a given day based on rotation.
 * Uses days since GLOBAL EPOCH (Jan 1) + platoonOffset for consistency across all stations.
 * Returns: 'day' | 'night' | 'rest'
 */
function getRotationStatus(
  daysSinceEpoch: number,
  platoonOffset: number,
  dayShifts: number,
  nightShifts: number,
  restDays: number,
): 'day' | 'night' | 'rest' {
  const cycleLength = dayShifts + nightShifts + restDays;
  const adjustedDay = ((daysSinceEpoch - platoonOffset) % cycleLength + cycleLength) % cycleLength;
  if (adjustedDay < dayShifts) return 'day';
  if (adjustedDay < dayShifts + nightShifts) return 'night';
  return 'rest';
}

/** A computed (not-yet-persisted) shift row + its rotation kind, for diffing. */
export interface ComputedShift {
  guardId: string;
  stationId: string;
  positionId: string | null;
  guardAssignmentId: string;
  postSiteId: string | null;
  startTime: Date;
  endTime: Date;
  shiftType: 'day' | 'night' | 'adhoc';
}

/**
 * PURE compute: return the shifts an assignment WOULD have, without touching the
 * database (no delete, no create). The single source of rotation math, reused by
 * both the live generator (below) and the draft/proposal engine. This is what
 * makes a draft-first, diff-before-publish workflow possible.
 */
export async function computeShiftsForAssignment(
  database: any,
  assignment: AssignmentData,
  tenantId: string,
): Promise<ComputedShift[]> {
  // Window (shared by all kinds): from max(startDate, today) for 365 days unless
  // an explicit endDate is given.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(assignment.startDate);
  const genStart = startDate > today ? startDate : today;
  const tz = await tenantTz(database, tenantId);

  const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId'] });
  const postSiteId = station?.postSiteId || null;

  // ─── AD-HOC (manual, non-rotation) ──────────────────────────────────────
  if (assignment.kind === 'adhoc') {
    const genEnd = assignment.endDate ? new Date(assignment.endDate) : new Date(genStart);
    const startHHmm = assignment.startTime || '07:00';
    const endHHmm = assignment.endTime || '19:00';
    const rows: ComputedShift[] = [];
    const cursor = new Date(genStart);
    while (cursor <= genEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const startTime = wallClockToUtc(dateStr, startHHmm, tz);
      let endTime = wallClockToUtc(dateStr, endHHmm, tz);
      if (endTime <= startTime) endTime = new Date(endTime.getTime() + 86400000);
      rows.push({
        guardId: assignment.guardId,
        stationId: assignment.stationId,
        positionId: null,
        guardAssignmentId: assignment.id,
        postSiteId,
        startTime,
        endTime,
        shiftType: 'adhoc',
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return rows;
  }

  const rotationStyle = await database.rotationStyle.findByPk(assignment.rotationStyleId);
  if (!rotationStyle) {
    console.error('[shiftGen] Rotation style not found:', assignment.rotationStyleId);
    return [];
  }
  const position = await database.stationPosition.findByPk(assignment.positionId);
  if (!position) {
    console.error('[shiftGen] Position not found:', assignment.positionId);
    return [];
  }

  const { dayShifts, nightShifts, restDays } = rotationStyle;
  const genEnd = assignment.endDate
    ? new Date(assignment.endDate)
    : new Date(today.getTime() + GENERATION_DAYS * 24 * 60 * 60 * 1000);

  const dayStartTime = position.startTime || '07:00';
  const dayEndTime = position.endTime || '19:00';
  const nightStartTime = dayEndTime;
  const nightEndTime = dayStartTime;

  // Both fijo and sacafranco walk their OWN rotation (D/N/L) from the global
  // epoch; the only difference today is the comment/semantics (SF coverage is
  // implicit). Identical row math → one loop.
  const rows: ComputedShift[] = [];
  const cursor = new Date(genStart);
  const epoch = getGlobalEpoch(genStart);
  while (cursor <= genEnd) {
    const daysSinceEpoch = Math.floor((cursor.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
    const status = getRotationStatus(daysSinceEpoch, assignment.platoonOffset, dayShifts, nightShifts, restDays);
    if (status !== 'rest') {
      const dateStr = cursor.toISOString().slice(0, 10);
      let startTime: Date;
      let endTime: Date;
      if (status === 'day') {
        startTime = wallClockToUtc(dateStr, dayStartTime, tz);
        endTime = wallClockToUtc(dateStr, dayEndTime, tz);
      } else {
        startTime = wallClockToUtc(dateStr, nightStartTime, tz);
        endTime = wallClockToUtc(dateStr, nightEndTime, tz);
      }
      if (endTime <= startTime) endTime = new Date(endTime.getTime() + 86400000);
      rows.push({
        guardId: assignment.guardId,
        stationId: assignment.stationId,
        positionId: assignment.positionId,
        guardAssignmentId: assignment.id,
        postSiteId,
        startTime,
        endTime,
        shiftType: status,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return rows;
}

/**
 * Generate shifts for a single guard assignment (LIVE write path).
 * Force-deletes this assignment's future shifts and recreates them from the
 * computed rotation. Behaviour unchanged — it now delegates the math to
 * computeShiftsForAssignment.
 */
export async function generateShiftsForAssignment(
  database: any,
  assignment: AssignmentData,
  tenantId: string,
  userId: string,
) {
  const { Op } = database.Sequelize;

  const computed = await computeShiftsForAssignment(database, assignment, tenantId);

  // Generation window start = max(startDate, today): only future shifts are replaced.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(assignment.startDate);
  const genStart = startDate > today ? startDate : today;

  await database.shift.destroy({
    where: { guardAssignmentId: assignment.id, tenantId, startTime: { [Op.gte]: genStart } },
    force: true,
  });

  if (computed.length === 0) return;

  const rows = computed.map((c) => ({
    guardId: c.guardId,
    stationId: c.stationId,
    positionId: c.positionId,
    guardAssignmentId: c.guardAssignmentId,
    postSiteId: c.postSiteId,
    startTime: c.startTime,
    endTime: c.endTime,
    tenantId,
    createdById: userId,
    updatedById: userId,
  }));
  await database.shift.bulkCreate(rows, { ignoreDuplicates: true });
  console.log(`[shiftGen] Created ${rows.length} shifts for assignment ${assignment.id} (guard: ${assignment.guardId})`);
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
 * Algorithm: SEQUENTIAL STATION REST DAYS
 * 1. Group stations by cycle length (same rotation type)
 * 2. Within each group, assign ALL fijos at the same station the SAME offset
 * 3. Sequence stations so rest days form a chain:
 *    - Station 0 rests days 0-1 (Mon-Tue)
 *    - Station 1 rests days 2-3 (Wed-Thu)
 *    - Station 2 rests days 4-5 (Fri-Sat)
 *    - etc.
 * 4. Sacafrancos then naturally cover consecutive stations in sequence
 * 5. SF offsets are staggered so they don't all rest on the same day
 * 
 * Offset formula (relative to Jan 1 epoch):
 *   stationOffset = (stationIndex * restDays - workDays + cycle) % cycle
 *   This makes station `i` rest starting on day `i * restDays` of the cycle
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
    order: [['stationName', 'ASC']], // Sort alphabetically for deterministic ordering
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

  // 4. SEQUENTIAL OFFSET OPTIMIZATION
  // Group fijos by station
  const fijosByStation = new Map<string, any[]>();
  for (const fijo of fijoPositions) {
    if (!fijosByStation.has(fijo.stationId)) fijosByStation.set(fijo.stationId, []);
    fijosByStation.get(fijo.stationId)!.push(fijo);
  }

  // Group stations by cycle length, then assign sequential offsets within each group
  const byCycle = new Map<number, { station: any; rot: any }[]>();
  for (const station of stations) {
    const rot = rotationCache.get(station.rotationStyleId);
    if (!rot) continue;
    const cycle = rot.dayShifts + rot.nightShifts + rot.restDays;
    if (cycle === 0) continue;
    if (!byCycle.has(cycle)) byCycle.set(cycle, []);
    byCycle.get(cycle)!.push({ station, rot });
  }

  // Assign sequential offsets: each station gets a slot so rest days form a chain
  const offsetUpdates: { id: string; platoonOffset: number }[] = [];
  for (const [cycle, stationGroup] of byCycle.entries()) {
    for (let i = 0; i < stationGroup.length; i++) {
      const { station, rot } = stationGroup[i];
      const workDays = rot.dayShifts + rot.nightShifts;
      const restDays = rot.restDays;
      
      // Formula: station i rests starting on day (i * restDays) % cycle relative to epoch
      // offset = (i * restDays - workDays + cycle) % cycle
      const stationOffset = (i * restDays - workDays + cycle * 10) % cycle; // +cycle*10 to avoid negative

      // ALL fijos at this station get the SAME offset
      const stationFijos = fijosByStation.get(station.id) || [];
      for (const fijo of stationFijos) {
        if (fijo.platoonOffset !== stationOffset) {
          offsetUpdates.push({ id: fijo.id, platoonOffset: stationOffset });
        }
      }
    }
  }

  // Apply offset updates to positions and their active assignments
  for (const update of offsetUpdates) {
    await database.stationPosition.update(
      { platoonOffset: update.platoonOffset },
      { where: { id: update.id, tenantId } }
    );
    await database.guardAssignment.update(
      { platoonOffset: update.platoonOffset },
      { where: { positionId: update.id, tenantId, status: 'active', deletedAt: null } }
    );
  }

  // 5. Build station configs with optimized offsets for staffing calculation
  const stationConfigs: any[] = [];
  for (const [cycle, stationGroup] of byCycle.entries()) {
    for (let i = 0; i < stationGroup.length; i++) {
      const { station, rot } = stationGroup[i];
      const workDays = rot.dayShifts + rot.nightShifts;
      const stationOffset = (i * rot.restDays - workDays + cycle * 10) % cycle;
      const stationFijos = fijosByStation.get(station.id) || [];

      stationConfigs.push({
        stationId: station.id,
        stationName: station.stationName,
        fijoPositions: stationFijos.map(() => ({
          platoonOffset: stationOffset,
          dayShifts: rot.dayShifts,
          nightShifts: rot.nightShifts,
          restDays: rot.restDays,
        })),
      });
    }
  }

  // 6. Get or determine SF rotation style — prefer 6-1 (best work ratio: 6/7 = 86%)
  let sfRotationStyleId = sacafrancoRotationStyleId;
  if (!sfRotationStyleId) {
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

  // 8. Preserve SF guards/assignments and rebalance SF positions by sequential coverage
  const sfCycle = sfRotation.dayShifts + sfRotation.nightShifts + sfRotation.restDays;
  const stationsWithFijos = stationConfigs.filter(s => s.fijoPositions.length > 0);
  const sfWorkDays = sfRotation.dayShifts + sfRotation.nightShifts;

  const existingSfAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
    attributes: ['id', 'guardId', 'stationId', 'positionId', 'startDate', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });

  // Keep at least enough SF slots for currently assigned SF guards.
  const targetSfCount = Math.max(numSfNeeded, existingSfAssignments.length);

  if (stationsWithFijos.length === 0 || targetSfCount === 0) {
    return {
      message: `No se necesitan sacafrancos (${stationsWithFijos.length} estaciones sin gaps)`,
      details: {
        totalStations: stations.length,
        sacafrancosNeeded: 0,
        fijosNeeded: staffing.fijosNeeded,
        offsetsOptimized: offsetUpdates.length,
        sfAssignmentsPreserved: existingSfAssignments.length,
      },
    };
  }

  const stationScheduleById = new Map<string, string>();
  stations.forEach((st: any) => stationScheduleById.set(st.id, st.scheduleType || '24h'));

  type TargetSfSlot = {
    index: number;
    stationId: string;
    startTime: string;
    endTime: string;
    platoonOffset: number;
    sortOrder: number;
    name: string;
  };

  const targetSlots: TargetSfSlot[] = [];
  for (let i = 0; i < targetSfCount; i++) {
    // SF i rests on sequential days (for 6-1 => M,T,W,T,F,S,D)
    const sfOffset = (i * sfRotation.restDays - sfWorkDays + sfCycle * 10) % sfCycle;
    const stationId = stationsWithFijos[i % stationsWithFijos.length].stationId;
    const scheduleType = stationScheduleById.get(stationId) || '24h';
    const isNightStation = scheduleType === '12h-night';
    targetSlots.push({
      index: i,
      stationId,
      startTime: isNightStation ? '19:00' : '07:00',
      endTime: isNightStation ? '07:00' : '19:00',
      platoonOffset: sfOffset,
      sortOrder: 100 + i,
      name: `SF ${i + 1}`,
    });
  }

  const existingSfPositions = await database.stationPosition.findAll({
    where: { tenantId, deletedAt: null, type: 'sacafranco' },
    attributes: ['id', 'stationId', 'sortOrder', 'platoonOffset'],
    order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
  });

  const assignedSfPositionIds = new Set(existingSfAssignments.map((a: any) => a.positionId).filter(Boolean));
  const pinnedPositions = existingSfPositions.filter((p: any) => assignedSfPositionIds.has(p.id));
  const freePositions = existingSfPositions.filter((p: any) => !assignedSfPositionIds.has(p.id));
  const reusablePositions = [...pinnedPositions, ...freePositions];

  const selectedPositionIds: string[] = [];

  // Update/reuse existing positions for target slots.
  const reuseCount = Math.min(reusablePositions.length, targetSlots.length);
  for (let i = 0; i < reuseCount; i++) {
    const slot = targetSlots[i];
    const pos = reusablePositions[i];
    await database.stationPosition.update(
      {
        name: slot.name,
        startTime: slot.startTime,
        endTime: slot.endTime,
        sortOrder: slot.sortOrder,
        platoonOffset: slot.platoonOffset,
        stationId: slot.stationId,
        updatedById: userId,
      },
      { where: { id: pos.id, tenantId } },
    );
    selectedPositionIds.push(pos.id);
  }

  // Create missing positions if target requires more than existing pool.
  for (let i = reuseCount; i < targetSlots.length; i++) {
    const slot = targetSlots[i];
    const created = await database.stationPosition.create({
      name: slot.name,
      type: 'sacafranco',
      startTime: slot.startTime,
      endTime: slot.endTime,
      guardsNeeded: 1,
      sortOrder: slot.sortOrder,
      platoonOffset: slot.platoonOffset,
      stationId: slot.stationId,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });
    selectedPositionIds.push(created.id);
  }

  // Delete only unassigned extra SF positions (never drop positions still tied to active SF guards).
  const selectedSet = new Set(selectedPositionIds);
  const extraUnusedPosIds = existingSfPositions
    .filter((p: any) => !selectedSet.has(p.id) && !assignedSfPositionIds.has(p.id))
    .map((p: any) => p.id);

  if (extraUnusedPosIds.length > 0) {
    await database.shift.destroy({ where: { positionId: extraUnusedPosIds, tenantId }, force: true });
    await database.stationPosition.destroy({ where: { id: extraUnusedPosIds, tenantId }, force: true });
  }

  // Rebind existing SF assignments onto target positions to preserve SF guards after optimization.
  const selectedPositions = await database.stationPosition.findAll({
    where: { id: selectedPositionIds, tenantId },
    attributes: ['id', 'stationId', 'platoonOffset', 'sortOrder'],
    order: [['sortOrder', 'ASC']],
  });

  for (let i = 0; i < existingSfAssignments.length; i++) {
    const a = existingSfAssignments[i];
    const targetPos = selectedPositions[i];
    if (!targetPos) break;
    await database.guardAssignment.update(
      {
        positionId: targetPos.id,
        stationId: targetPos.stationId,
        rotationStyleId: sfRotationStyleId,
        platoonOffset: targetPos.platoonOffset || 0,
        isRelief: true,
        updatedById: userId,
      },
      { where: { id: a.id, tenantId } },
    );
  }

  // 9. Regenerate shifts for all fixed + active SF assignments after offset/position rebalance
  const allFijoAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, positionId: fijoPositions.map((f: any) => f.id) },
  });
  const allSfAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
  });

  const regenAssignments = [...allFijoAssignments, ...allSfAssignments];
  const batchSize = 10;
  for (let i = 0; i < regenAssignments.length; i += batchSize) {
    const batch = regenAssignments.slice(i, i + batchSize);
    await Promise.all(
      batch.map((a: any) => generateShiftsForAssignment(database, a.get({ plain: true }), tenantId, userId))
    );
  }

  return {
    message: `Optimizado: ${targetSfCount} sacafrancos para ${stationsWithFijos.length} estaciones. Secuencia: L se cubre en cadena por estación sin perder SF asignados.`,
    details: {
      totalStations: stationsWithFijos.length,
      sacafrancosNeeded: numSfNeeded,
      sacafrancosConfigured: targetSfCount,
      fijosNeeded: staffing.fijosNeeded,
      peakDemand: staffing.peakDemand,
      offsetsOptimized: offsetUpdates.length,
      rotationStyleId: sfRotationStyleId,
      sfAssignmentsPreserved: existingSfAssignments.length,
      sequenceInfo: `Stations sequenced by rest day: each station's rest is offset by ${stationConfigs[0]?.fijoPositions[0]?.restDays || 2} days`,
    },
  };
}
