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
import { requiredHalves, TurnoHalf } from './scheduleCoverageService';

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
  coveredStationIds?: string[] | null; // sacafranco: the stations it relieves
  kind?: 'rotation' | 'adhoc';
  startTime?: string | null; // HH:mm, adhoc only
  endTime?: string | null;   // HH:mm, adhoc only
}

/**
 * THE rotation epoch — day-zero for every rotation calculation, so platoonOffset
 * means the same thing in the generator, the staffing/gap analyzers, and the
 * frontend grid. The single source of truth: all consumers MUST use this.
 *
 * FIXED anchor (Phase 7): previously this was Jan 1 of the *reference year*, so
 * the rotation phase silently jumped every Jan 1 and the analyzer/grid disagreed
 * with persisted shifts for the tail of the year. A fixed anchor removes that
 * year-boundary drift permanently. The `referenceDate` argument is ignored.
 */
const ROTATION_EPOCH = new Date(2024, 0, 1);
export function getGlobalEpoch(_referenceDate?: Date): Date {
  return new Date(ROTATION_EPOCH.getTime());
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

/**
 * Which coverage HALF a fijo fills given the station's scheduleType. A 12h-night
 * station runs a 5-2 rotation (nightShifts=0 ⇒ status is 'day'), but the fijo
 * actually covers the NIGHT half — so map by scheduleType, not the raw status.
 * Returns null when the fijo is resting.
 */
function coveredHalf(scheduleType: string | null | undefined, status: 'day' | 'night' | 'rest'): TurnoHalf | null {
  if (status === 'rest') return null;
  if (scheduleType === '12h-day') return 'day';
  if (scheduleType === '12h-night') return 'night';
  // 24h (or custom): the day block covers the day half, the night block the night half.
  return status === 'night' ? 'night' : 'day';
}

/** Canonical wall-clock hours for a coverage half (day 07–19, night 19–07);
 *  custom stations fall back to their fijo's own hours for the day half. */
function halfHours(scheduleType: string | null | undefined, half: TurnoHalf, fijoStart?: string, fijoEnd?: string): { start: string; end: string } {
  const isStandard = scheduleType === '24h' || scheduleType === '12h-day' || scheduleType === '12h-night';
  if (half === 'night') return { start: '19:00', end: '07:00' };
  if (isStandard) return { start: '07:00', end: '19:00' };
  return { start: fijoStart || '07:00', end: fijoEnd || '19:00' };
}

interface FijoGap {
  stationId: string;
  half: TurnoHalf;
  startHHmm: string;
  endHHmm: string;
  postSiteId: string | null;
}

/**
 * For each day in the window, which (station, half) slots have NO fijo on duty —
 * i.e. the real rest gaps a sacafranco must cover. Computed straight from the
 * covered stations' fijo positions' rotation (no shift rows generated). This is
 * what makes sacafranco relief REAL instead of the SF working its own rotation.
 */
async function computeFijoGaps(
  database: any,
  coveredStationIds: string[],
  tenantId: string,
  genStart: Date,
  genEnd: Date,
): Promise<Map<string, FijoGap[]>> {
  const gapsByDay = new Map<string, FijoGap[]>();
  const epoch = getGlobalEpoch(genStart);

  for (const sid of coveredStationIds) {
    const st = await database.station.findByPk(sid, { attributes: ['id', 'scheduleType', 'rotationStyleId', 'postSiteId'] });
    if (!st || !st.rotationStyleId) continue;
    const rot = await database.rotationStyle.findByPk(st.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
    if (!rot) continue;
    const fijos = await database.stationPosition.findAll({
      where: { stationId: sid, tenantId, deletedAt: null, type: 'fijo' },
      attributes: ['platoonOffset', 'startTime', 'endTime'],
    });
    if (!fijos.length) continue;

    const required = requiredHalves(st.scheduleType);

    const cursor = new Date(genStart);
    while (cursor <= genEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dse = Math.floor((cursor.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
      const coveredHalves = new Set<string>();
      for (const f of fijos) {
        const s = getRotationStatus(dse, f.platoonOffset || 0, rot.dayShifts, rot.nightShifts, rot.restDays);
        const h = coveredHalf(st.scheduleType, s);
        if (h) coveredHalves.add(h);
      }
      for (const half of required) {
        if (!coveredHalves.has(half)) {
          const hrs = halfHours(st.scheduleType, half, fijos[0].startTime, fijos[0].endTime);
          if (!gapsByDay.has(dateStr)) gapsByDay.set(dateStr, []);
          gapsByDay.get(dateStr)!.push({
            stationId: sid,
            half,
            startHHmm: hrs.start,
            endHHmm: hrs.end,
            postSiteId: st.postSiteId || null,
          });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return gapsByDay;
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

  // ─── SACAFRANCO (real relief) ───────────────────────────────────────────
  // The SF works on its OWN rotation work-days (so it gets its rest days and all
  // SFs keep the same turno style), but on each work-day it goes WHERE a fijo is
  // actually resting — among its coveredStationIds — in that gap's half. If there
  // is no real gap that day it stays idle (no over-coverage). Multiple SFs spread
  // across the day's gaps by platoonOffset. Residual gaps are surfaced by the
  // coverage analyzer + blocked at publish, so an imperfect spread can't ship.
  const isSacafranco = position.type === 'sacafranco' || assignment.isRelief;
  if (isSacafranco) {
    const covered =
      Array.isArray(assignment.coveredStationIds) && assignment.coveredStationIds.length
        ? assignment.coveredStationIds
        : [assignment.stationId];
    const gapsByDay = await computeFijoGaps(database, covered, tenantId, genStart, genEnd);

    // This SF's index among the sitio's SFs, so when >1 SF is needed they
    // partition each day's gaps (SF i takes the i-th gap) instead of fighting
    // over the same one.
    const sfPositions = await database.stationPosition.findAll({
      where: { tenantId, deletedAt: null, type: 'sacafranco', stationId: covered },
      attributes: ['id', 'sortOrder'],
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    let sfIndex = sfPositions.findIndex((p: any) => String(p.id) === String(assignment.positionId));
    if (sfIndex < 0) sfIndex = 0;

    // GAP-DRIVEN + LABOR CAP, COORDINATED: every SF follows a FIXED rotation
    // (the cap — e.g. 6-1 ⇒ works 6, rests 1) with rest days STAGGERED by index,
    // so the SFs collectively cover the chain. On a work-day, SF i claims the
    // gap at position = (how many lower-index SFs are also working today) — a
    // deterministic split that needs no shared state. Gaps beyond the working-SF
    // count that day are left for the coverage analyzer to flag.
    const sfRot = { dayShifts, nightShifts, restDays };
    const sfRows: ComputedShift[] = [];
    const cursor = new Date(genStart);
    const epoch = getGlobalEpoch(genStart);
    while (cursor <= genEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dse = Math.floor((cursor.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
      if (sfWorks(sfIndex, dse, sfRot)) {
        const gaps = (gapsByDay.get(dateStr) || [])
          .slice()
          .sort((a, b) => `${a.stationId}|${a.half}`.localeCompare(`${b.stationId}|${b.half}`));
        let claim = 0;
        for (let j = 0; j < sfIndex; j++) if (sfWorks(j, dse, sfRot)) claim++;
        const pick = gaps[claim];
        if (pick) {
          const startTime = wallClockToUtc(dateStr, pick.startHHmm, tz);
          let endTime = wallClockToUtc(dateStr, pick.endHHmm, tz);
          if (endTime <= startTime) endTime = new Date(endTime.getTime() + 86400000);
          sfRows.push({
            guardId: assignment.guardId,
            stationId: pick.stationId,
            positionId: assignment.positionId,
            guardAssignmentId: assignment.id,
            postSiteId: pick.postSiteId || postSiteId,
            startTime,
            endTime,
            shiftType: pick.half,
          });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return sfRows;
  }

  // ─── FIJO ───────────────────────────────────────────────────────────────
  // Walks its OWN rotation (D/N/L) from the global epoch at its own station.
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

// ─── Dynamic offset spreading + SF sizing (gap-driven coverage) ─────────────

const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
const lcm2 = (a: number, b: number): number => (a && b ? Math.abs(a * b) / gcd2(a, b) : Math.max(a, b));

interface StationSpreadInfo {
  stationId: string;
  scheduleType: string | null;
  rot: { dayShifts: number; nightShifts: number; restDays: number };
  fijos: { id: string; sortOrder: number }[]; // sorted by sortOrder
}

/**
 * Day indices (0..L-1), one entry per uncovered REQUIRED half-slot, given a
 * station's fijo offsets. Pure in-memory mirror of computeFijoGaps, used to
 * evaluate candidate offsets while spreading.
 */
function stationGapSlots(
  scheduleType: string | null | undefined,
  rot: { dayShifts: number; nightShifts: number; restDays: number },
  fijoOffsets: number[],
  L: number,
): number[] {
  const halves = requiredHalves(scheduleType);
  const out: number[] = [];
  for (let d = 0; d < L; d++) {
    const covered = new Set<string>();
    for (const off of fijoOffsets) {
      const s = getRotationStatus(d, off, rot.dayShifts, rot.nightShifts, rot.restDays);
      const h = coveredHalf(scheduleType, s);
      if (h) covered.add(h);
    }
    for (const h of halves) if (!covered.has(h)) out.push(d);
  }
  return out;
}

/**
 * Greedily choose each station's base offset so rest-gaps spread across the
 * super-cycle (minimize the PEAK number of concurrent gaps per day → fewest SFs).
 * 24h stations stagger their two fijos by dayShifts. Returns each fijo position's
 * offset, the per-day gap load over the super-cycle, the cycle length and peak.
 */
function spreadStationOffsets(stations: StationSpreadInfo[]): {
  offsets: Map<string, number>;
  dayLoad: number[];
  L: number;
  peak: number;
} {
  const cycles = stations
    .map((s) => s.rot.dayShifts + s.rot.nightShifts + s.rot.restDays)
    .filter((c) => c > 0);
  let L = cycles.reduce((a, c) => lcm2(a, c), 1);
  if (!Number.isFinite(L) || L <= 0) L = 7;
  if (L > 366) L = Math.max(...cycles, 7) * 2;

  const offsets = new Map<string, number>();
  const dayLoad = new Array(L).fill(0);

  // Place the most-constrained stations (most gap-slots) first.
  const ordered = stations
    .map((st) => {
      const cycle = st.rot.dayShifts + st.rot.nightShifts + st.rot.restDays;
      const base0 = st.fijos.map((_, k) => ((0 - k * st.rot.dayShifts) % cycle + cycle) % cycle);
      return { st, cycle, gapCount: stationGapSlots(st.scheduleType, st.rot, base0, L).length };
    })
    .sort((a, b) => b.gapCount - a.gapCount);

  for (const { st, cycle } of ordered) {
    if (cycle <= 0 || !st.fijos.length) continue;
    let bestO = 0;
    let bestPeak = Infinity;
    let bestSpread = Infinity;
    let bestSlots: number[] = [];
    for (let o = 0; o < cycle; o++) {
      const fijoOffsets = st.fijos.map((_, k) => ((o - k * st.rot.dayShifts) % cycle + cycle) % cycle);
      const slots = stationGapSlots(st.scheduleType, st.rot, fijoOffsets, L);
      const test = dayLoad.slice();
      for (const d of slots) test[d % L]++;
      let peak = 0;
      let sumSq = 0;
      for (const v of test) { if (v > peak) peak = v; sumSq += v * v; }
      if (peak < bestPeak || (peak === bestPeak && sumSq < bestSpread)) {
        bestPeak = peak; bestSpread = sumSq; bestO = o; bestSlots = slots;
      }
    }
    const fijoOffsets = st.fijos.map((_, k) => ((bestO - k * st.rot.dayShifts) % cycle + cycle) % cycle);
    st.fijos.forEach((f, k) => offsets.set(f.id, fijoOffsets[k]));
    for (const d of bestSlots) dayLoad[d % L]++;
  }

  const peak = dayLoad.reduce((m, v) => Math.max(m, v), 0);
  return { offsets, dayLoad, L, peak };
}

/**
 * Minimal number of sacafrancos (gap-driven + labor cap) to cover the per-day
 * gap load over the super-cycle. Each SF covers one gap/day up to the cap's
 * consecutive workdays, then a forced rest; we grow N until all gaps are covered
 * (or a small bound). Returns the count + residual flagged (uncovered) slots.
 */
function computeSfPlan(
  dayLoad: number[],
  sfRot: { dayShifts: number; nightShifts: number; restDays: number },
): { sfCount: number; flaggedGaps: number } {
  const L = dayLoad.length;
  const totalGaps = dayLoad.reduce((a, v) => a + v, 0);
  if (totalGaps === 0) return { sfCount: 0, flaggedGaps: 0 };
  const peak = dayLoad.reduce((m, v) => Math.max(m, v), 0);

  // Each SF follows a FIXED rotation (the labor cap — e.g. 6-1 ⇒ works 6, rests
  // 1), with rest days STAGGERED by index so they never all rest together. SF i
  // works day d iff its rotation is in a work block. Coverage on day d holds when
  // (number of SFs working) ≥ dayLoad[d]. Grow N until every day is covered.
  const cycle = Math.max(1, sfRot.dayShifts + sfRot.nightShifts + sfRot.restDays);
  const workDays = Math.max(1, sfRot.dayShifts + sfRot.nightShifts);
  const sfWorking = (i: number, d: number) => (((d - i) % cycle) + cycle) % cycle < workDays;
  const flaggedFor = (N: number): number => {
    let fl = 0;
    for (let d = 0; d < L; d++) {
      let wc = 0;
      for (let i = 0; i < N; i++) if (sfWorking(i, d)) wc++;
      fl += Math.max(0, dayLoad[d] - wc);
    }
    return fl;
  };

  let N = Math.max(1, peak);
  let guard = 0;
  while (flaggedFor(N) > 0 && guard < 30) { N++; guard++; }
  return { sfCount: N, flaggedGaps: flaggedFor(N) };
}

/** Same staggered fixed-rotation predicate the SF runtime uses: SF index `i`
 *  works on day-since-epoch `dse` (rest staggered by index). */
function sfWorks(i: number, dse: number, sfRot: { dayShifts: number; nightShifts: number; restDays: number }): boolean {
  const cycle = Math.max(1, sfRot.dayShifts + sfRot.nightShifts + sfRot.restDays);
  const workDays = Math.max(1, sfRot.dayShifts + sfRot.nightShifts);
  return (((dse - i) % cycle) + cycle) % cycle < workDays;
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
    attributes: ['id', 'stationName', 'rotationStyleId', 'scheduleType', 'postSiteId'],
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

  // 4. DYNAMIC GAP-SPREADING OFFSETS — choose each station's base offset so
  // rest-gaps spread across the super-cycle (fewest concurrent gaps → fewest SFs).
  // 24h stations stagger their two fijos by dayShifts.
  const fijosByStation = new Map<string, any[]>();
  for (const fijo of fijoPositions) {
    if (!fijosByStation.has(fijo.stationId)) fijosByStation.set(fijo.stationId, []);
    fijosByStation.get(fijo.stationId)!.push(fijo);
  }

  const spreadInfo: StationSpreadInfo[] = [];
  for (const station of stations) {
    const rot = rotationCache.get(station.rotationStyleId);
    if (!rot) continue;
    const fijos = (fijosByStation.get(station.id) || [])
      .slice()
      .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((f: any) => ({ id: f.id, sortOrder: f.sortOrder || 0 }));
    if (!fijos.length) continue;
    spreadInfo.push({
      stationId: station.id,
      scheduleType: station.scheduleType,
      rot: { dayShifts: rot.dayShifts, nightShifts: rot.nightShifts, restDays: rot.restDays },
      fijos,
    });
  }

  const spread = spreadStationOffsets(spreadInfo);

  // Apply the chosen offsets to fijo positions + their active assignments.
  const offsetUpdates: { id: string; platoonOffset: number }[] = [];
  for (const [posId, off] of spread.offsets.entries()) {
    const fijo = fijoPositions.find((f: any) => String(f.id) === String(posId));
    if (fijo && fijo.platoonOffset !== off) offsetUpdates.push({ id: posId, platoonOffset: off });
  }
  for (const update of offsetUpdates) {
    await database.stationPosition.update(
      { platoonOffset: update.platoonOffset },
      { where: { id: update.id, tenantId } },
    );
    await database.guardAssignment.update(
      { platoonOffset: update.platoonOffset },
      { where: { positionId: update.id, tenantId, status: 'active', deletedAt: null } },
    );
  }

  // 5. Resolve SF rotation style — prefer 6-1 (best work ratio: 6/7 = 86%).
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

  // 6. Size SFs dynamically: gap-driven coverage under the SF labor cap.
  const sfPlan = computeSfPlan(spread.dayLoad, {
    dayShifts: sfRotation.dayShifts,
    nightShifts: sfRotation.nightShifts,
    restDays: sfRotation.restDays,
  });
  const numSfNeeded = sfPlan.sfCount;
  const totalFijos = fijoPositions.length;

  // 7. Preserve SF guards/assignments and rebalance SF positions.
  const sfCycle = sfRotation.dayShifts + sfRotation.nightShifts + sfRotation.restDays;
  const stationsWithFijos = spreadInfo.map((s) => ({ stationId: s.stationId }));
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
        fijosNeeded: totalFijos,
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

  // Which sitio (post site) each fijo station belongs to, and the fijo stations
  // per sitio — so each SF's coveredStationIds reflects the stations it relieves
  // within its own sitio (req 3: no longer dead data; per-sitio coverage).
  const stationPostSite = new Map<string, string>(
    stations.map((s: any) => [s.id, s.postSiteId || 'none']),
  );
  const fijoStationsBySitio = new Map<string, string[]>();
  for (const sc of stationsWithFijos) {
    const sitio = stationPostSite.get(sc.stationId) || 'none';
    if (!fijoStationsBySitio.has(sitio)) fijoStationsBySitio.set(sitio, []);
    fijoStationsBySitio.get(sitio)!.push(sc.stationId);
  }

  for (let i = 0; i < existingSfAssignments.length; i++) {
    const a = existingSfAssignments[i];
    const targetPos = selectedPositions[i];
    if (!targetPos) break;
    const sitio = stationPostSite.get(targetPos.stationId) || 'none';
    const covered = fijoStationsBySitio.get(sitio) || [targetPos.stationId];
    await database.guardAssignment.update(
      {
        positionId: targetPos.id,
        stationId: targetPos.stationId,
        rotationStyleId: sfRotationStyleId,
        platoonOffset: targetPos.platoonOffset || 0,
        isRelief: true,
        coveredStationIds: covered,
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
    message: `Optimizado: ${targetSfCount} sacafranco(s) cubren ${stationsWithFijos.length} estaciones en cadena (gaps repartidos, pico ${spread.peak}/día).`,
    details: {
      totalStations: stationsWithFijos.length,
      sacafrancosNeeded: numSfNeeded,
      sacafrancosConfigured: targetSfCount,
      fijosNeeded: totalFijos,
      peakConcurrentGaps: spread.peak,
      flaggedGaps: sfPlan.flaggedGaps,
      superCycleDays: spread.L,
      offsetsOptimized: offsetUpdates.length,
      rotationStyleId: sfRotationStyleId,
      sfAssignmentsPreserved: existingSfAssignments.length,
    },
  };
}
