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
import { ymd } from './consignaRecurrence';
import { requiredHalves, TurnoHalf } from './scheduleCoverageService';

export const GENERATION_DAYS = 365; // Generate 1 full year of shifts
// Hard horizon for user-supplied endDates: one full calendar year (leap-safe).
// Anything beyond is rejected at the API boundary and clamped in the generator.
export const MAX_ASSIGNMENT_HORIZON_DAYS = GENERATION_DAYS + 1;

/**
 * Clamp a user-supplied generation end to the MAX_ASSIGNMENT_HORIZON_DAYS
 * horizon from genStart. A typo'd far-future endDate (e.g. 9999-12-31) would
 * otherwise walk millions of days and bulkCreate millions of rows, OOM-killing
 * the PM2 worker. createAssignment rejects such input at the API boundary; this
 * is the defense-in-depth backstop covering EVERY path into the day-walk
 * (direct create/update, rephase, auto-assign, yearly regen, sacafranco
 * optimization, orphan repair). An invalid endDate (NaN) passes through: the
 * day-walk `while (cursor <= genEnd)` is then simply never entered.
 */
function clampGenEnd(genStart: Date, genEnd: Date, assignmentId: string): Date {
  const maxEnd = new Date(genStart.getTime() + MAX_ASSIGNMENT_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  if (genEnd > maxEnd) {
    console.warn(
      `[shiftGen] clamping generation window for assignment ${assignmentId}: endDate ${genEnd.toISOString().slice(0, 10)} exceeds the ${MAX_ASSIGNMENT_HORIZON_DAYS}-day horizon (using ${maxEnd.toISOString().slice(0, 10)})`,
    );
    return maxEnd;
  }
  return genEnd;
}

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
  if (!coveredStationIds.length) return gapsByDay;
  const epoch = getGlobalEpoch(genStart);

  // Batch the lookups ONCE for all covered stations (3 queries total instead of
  // 3 per station — SFs are global, so this used to be 3×N sequential round-trips
  // per SF assignment). The per-station loop below then works purely in memory.
  const stationRows = await database.station.findAll({
    where: { id: coveredStationIds },
    attributes: ['id', 'scheduleType', 'rotationStyleId', 'postSiteId'],
  });
  const stationById = new Map<string, any>(stationRows.map((s: any) => [String(s.id), s]));
  const rotIds = Array.from(new Set(stationRows.map((s: any) => s.rotationStyleId).filter(Boolean)));
  const rotRows = rotIds.length
    ? await database.rotationStyle.findAll({
        where: { id: rotIds },
        attributes: ['id', 'dayShifts', 'nightShifts', 'restDays'],
      })
    : [];
  const rotById = new Map<string, any>(rotRows.map((r: any) => [String(r.id), r]));
  const fijoRows = await database.stationPosition.findAll({
    where: { stationId: coveredStationIds, tenantId, deletedAt: null, type: 'fijo' },
    attributes: ['stationId', 'platoonOffset', 'startTime', 'endTime'],
  });
  const fijosByStation = new Map<string, any[]>();
  for (const f of fijoRows) {
    const key = String(f.stationId);
    if (!fijosByStation.has(key)) fijosByStation.set(key, []);
    fijosByStation.get(key)!.push(f);
  }

  for (const sid of coveredStationIds) {
    const st = stationById.get(String(sid));
    if (!st || !st.rotationStyleId) continue;
    const rot = rotById.get(String(st.rotationStyleId));
    if (!rot) continue;
    const fijos = fijosByStation.get(String(sid)) || [];
    if (!fijos.length) continue;

    const required = requiredHalves(st.scheduleType);

    // Custom stations are BLOCK-based, not half-based: group fijos by their
    // block (start|end). A block is covered when ANY of its fijos works that
    // day — alternation (e.g. 24x24: two fijos sharing one block, phased so
    // one always works) thus produces zero gaps, and this also fixes the
    // multi-block hole where all blocks collapsed into one 'day' slot (the
    // morning fijo's rest went undetected while the afternoon fijo worked).
    const isCustom = st.scheduleType === 'custom';
    const blocks = new Map<string, { start: string; end: string; fijos: any[] }>();
    if (isCustom) {
      for (const f of fijos) {
        const bs = f.startTime || '07:00';
        const be = f.endTime || '19:00';
        const key = `${bs}|${be}`;
        if (!blocks.has(key)) blocks.set(key, { start: bs, end: be, fijos: [] });
        blocks.get(key)!.fijos.push(f);
      }
    }
    const blockHalf = (start: string): TurnoHalf => {
      const h = parseInt(String(start).split(':')[0], 10) || 0;
      return h >= 18 || h < 6 ? 'night' : 'day';
    };

    const cursor = new Date(genStart);
    while (cursor <= genEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dse = Math.floor((cursor.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
      if (isCustom) {
        for (const blk of blocks.values()) {
          const covered = blk.fijos.some((f: any) => {
            const s = getRotationStatus(dse, f.platoonOffset || 0, rot.dayShifts, rot.nightShifts, rot.restDays);
            return s !== 'rest';
          });
          if (!covered) {
            if (!gapsByDay.has(dateStr)) gapsByDay.set(dateStr, []);
            gapsByDay.get(dateStr)!.push({
              stationId: sid,
              half: blockHalf(blk.start),
              startHHmm: blk.start,
              endHHmm: blk.end,
              postSiteId: st.postSiteId || null,
            });
          }
        }
      } else {
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
  // an explicit endDate is given. "Today" is the TENANT's calendar day, not the
  // server's UTC day — otherwise, on a UTC server past tenant-midnight, the
  // floor rounds a guard assigned "hoy" up to tomorrow. Dates are anchored at
  // UTC-midnight of the tenant calendar date so cursor.toISOString().slice(0,10)
  // yields the correct tenant date fed to wallClockToUtc below.
  const tz = await tenantTz(database, tenantId);
  const todayStr = ymd(new Date(), tz);
  const startStr = String(assignment.startDate || todayStr).slice(0, 10);
  const genStartStr = startStr > todayStr ? startStr : todayStr;
  const today = new Date(`${todayStr}T00:00:00Z`);
  const genStart = new Date(`${genStartStr}T00:00:00Z`);

  const station = await database.station.findByPk(assignment.stationId, { attributes: ['postSiteId', 'rotationStyleId'] });
  const postSiteId = station?.postSiteId || null;

  // ─── AD-HOC (manual, non-rotation) ──────────────────────────────────────
  if (assignment.kind === 'adhoc') {
    const genEnd = assignment.endDate
      ? clampGenEnd(genStart, new Date(assignment.endDate), assignment.id)
      : new Date(genStart);
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

  // Rotation is a STATION property — inherit it. Fall back to the assignment's
  // own value only for legacy rows that still carry one.
  const rotationStyleId = station?.rotationStyleId || assignment.rotationStyleId;
  const rotationStyle = await database.rotationStyle.findByPk(rotationStyleId);
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
    ? clampGenEnd(genStart, new Date(assignment.endDate), assignment.id)
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
    // SFs are GLOBAL: cover every fijo station tenant-wide. Use the explicit
    // coveredStationIds when set, else default to ALL fijo stations (so an SF
    // assigned ad-hoc — without running the optimizer — still covers globally,
    // not just its home station).
    let covered: string[] =
      Array.isArray(assignment.coveredStationIds) && assignment.coveredStationIds.length
        ? assignment.coveredStationIds
        : [];
    if (!covered.length) {
      const fijoStations = await database.stationPosition.findAll({
        where: { tenantId, type: 'fijo', deletedAt: null },
        attributes: ['stationId'],
        group: ['stationId'],
      });
      covered = fijoStations.map((r: any) => String(r.stationId));
      if (!covered.length) covered = [assignment.stationId];
    }
    const epoch = getGlobalEpoch(genStart);
    const gapsByDay = await computeFijoGaps(database, covered, tenantId, genStart, genEnd);

    // This SF's index among ALL sacafrancos (global), ordered by sortOrder. All
    // SFs share the planned offset, so when >1 they split each day's same-half
    // gaps by index.
    const sfPositions = await database.stationPosition.findAll({
      where: { tenantId, deletedAt: null, type: 'sacafranco', stationId: covered },
      attributes: ['id', 'sortOrder'],
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    let sfIndex = sfPositions.findIndex((p: any) => String(p.id) === String(assignment.positionId));
    if (sfIndex < 0) sfIndex = 0;

    // STRICT 4-4-2: the SF works its DAY block (covering day-gaps), then its
    // NIGHT block (night-gaps), then rests — a feasible sequence (never a night
    // followed by a day the next morning). Its platoonOffset = the planned SF
    // offset that aligns gaps to these blocks.
    const sfRows: ComputedShift[] = [];
    const cursor = new Date(genStart);
    while (cursor <= genEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dse = Math.floor((cursor.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
      const status = getRotationStatus(dse, assignment.platoonOffset, dayShifts, nightShifts, restDays);
      if (status !== 'rest') {
        const wantHalf: TurnoHalf = status === 'night' ? 'night' : 'day';
        const gaps = (gapsByDay.get(dateStr) || [])
          .filter((g) => g.half === wantHalf)
          .sort((a, b) => `${a.stationId}`.localeCompare(`${b.stationId}`));
        const pick = gaps[sfIndex]; // SFs split the day's same-half gaps by index
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

  // Replace future shifts for THIS assignment, AND any future shifts at the same
  // rotation POSITION (regardless of who/what created them). Without the position
  // clause, re-assigning a slot left the previous occupant's shifts behind —
  // especially legacy shifts with a NULL guardAssignmentId (kept sticky by
  // ignoreDuplicates), so the station showed stale/duplicate coverage.
  const destroyWhere: any = { tenantId, startTime: { [Op.gte]: genStart }, [Op.or]: [{ guardAssignmentId: assignment.id }] };
  if ((assignment as any).positionId) destroyWhere[Op.or].push({ positionId: (assignment as any).positionId });
  await database.shift.destroy({ where: destroyWhere, force: true });

  // Enterprise guarantee — no double-booking: a guard holds at most ONE active
  // assignment, so any of their FUTURE shifts tied to a DIFFERENT, non-active
  // (ended/replaced) assignment are stale leftovers that would overlap this one.
  // Purge them whenever the guard's live assignment regenerates. Scoped to
  // ended/non-active OTHER assignments, so active adhoc/rotation shifts are kept.
  if (assignment.guardId) {
    const staleAssignments = await database.guardAssignment.findAll({
      where: {
        tenantId,
        guardId: assignment.guardId,
        id: { [Op.ne]: assignment.id },
        status: { [Op.ne]: 'active' },
      },
      attributes: ['id'],
    });
    const staleIds = (staleAssignments || []).map((a: any) => a.id).filter(Boolean);
    if (staleIds.length) {
      await database.shift.destroy({
        where: {
          tenantId,
          guardId: assignment.guardId,
          startTime: { [Op.gte]: genStart },
          guardAssignmentId: { [Op.in]: staleIds },
        },
        force: true,
      });
    }
  }

  if (computed.length === 0) return;

  let rows = computed.map((c) => ({
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

  // No double-booking — the universal backstop. Drop any computed shift that would
  // overlap an existing shift for the SAME guard from ANOTHER assignment. This
  // assignment's own future shifts were purged above, so what remains is "other
  // assignments" (incl. a sacafranco wrongly assigned to two stations at once, or
  // the auto-assign bulk path). A guard can't be two places at once — a coverage
  // gap is preferable to a physically-impossible double-booking.
  if (assignment.guardId && rows.length) {
    const winStart = rows.reduce((m, r) => (r.startTime < m ? r.startTime : m), rows[0].startTime);
    const winEnd = rows.reduce((m, r) => (r.endTime > m ? r.endTime : m), rows[0].endTime);
    const existing = await database.shift.findAll({
      where: {
        tenantId,
        guardId: assignment.guardId,
        startTime: { [Op.lt]: winEnd },
        endTime: { [Op.gt]: winStart },
      },
      attributes: ['startTime', 'endTime', 'guardAssignmentId'],
    });
    const ex = (existing || [])
      .filter((e: any) => String(e.guardAssignmentId) !== String(assignment.id))
      .map((e: any) => ({ s: new Date(e.startTime).getTime(), e: new Date(e.endTime).getTime() }));
    if (ex.length) {
      const before = rows.length;
      rows = rows.filter((r) => {
        const rs = new Date(r.startTime).getTime();
        const re = new Date(r.endTime).getTime();
        return !ex.some((x) => rs < x.e && x.s < re);
      });
      if (rows.length !== before) {
        console.warn(`[shiftGen] dropped ${before - rows.length} overlapping shift(s) for guard ${assignment.guardId} (assignment ${assignment.id})`);
      }
    }
  }

  if (!rows.length) return;
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
 * Plan ALL fijo offsets + the sacafranco offset so that ONE (or fewest) SF on a
 * real DAY→NIGHT→REST rotation can cover every station's rest-gaps — feasibly.
 *
 * Key feasibility rule: a sacafranco works its DAY block, then its NIGHT block,
 * then rests — it can NEVER do a night then a day the next morning. So we must
 * arrange the guards' rest days so every DAY gap lands on the SF's day-block and
 * every NIGHT gap on its night-block. For each candidate SF offset we greedily
 * choose each station's offset to push its day-gaps into the day-block and
 * night-gaps into the night-block (least-loaded day first), then size N = the
 * peak per-block load. We keep the SF offset with no out-of-block gaps and the
 * fewest SFs.
 */
async function planStationsAndSf(
  stations: StationSpreadInfo[],
  sfRot: { dayShifts: number; nightShifts: number; restDays: number },
): Promise<{ fijoOffsets: Map<string, number>; sfOffset: number; sfCount: number; L: number; dayLoad: number[]; nightLoad: number[]; outOfBlock: number }> {
  const sfCycle = Math.max(1, sfRot.dayShifts + sfRot.nightShifts + sfRot.restDays);
  const cycles = stations.map((s) => s.rot.dayShifts + s.rot.nightShifts + s.rot.restDays).filter((c) => c > 0);
  cycles.push(sfCycle);
  let L = cycles.reduce((a, c) => lcm2(a, c), 1);
  if (!Number.isFinite(L) || L <= 0) L = sfCycle;
  if (L > 366) L = Math.max(...cycles, sfCycle) * 2;

  // SF coverage half on day d for a given SF offset: 'day' (day-block), 'night'
  // (night-block) or null (rest).
  const sfHalf = (d: number, sfOff: number): 'day' | 'night' | null => {
    const s = getRotationStatus(d, sfOff, sfRot.dayShifts, sfRot.nightShifts, sfRot.restDays);
    return s === 'rest' ? null : s === 'night' ? 'night' : 'day';
  };

  // Order stations most-constrained first (24h, then by required halves).
  const ordered = stations.slice().sort((a, b) => {
    const ra = requiredHalves(a.scheduleType).length, rb = requiredHalves(b.scheduleType).length;
    return rb - ra;
  });

  let best: { fijoOffsets: Map<string, number>; sfOffset: number; sfCount: number; dayLoad: number[]; nightLoad: number[]; outOfBlock: number } | null = null;

  for (let sfOff = 0; sfOff < sfCycle; sfOff++) {
    // Cooperative yield: this planner is O(sfCycle×stations×cycle×L) of pure
    // synchronous CPU inside a request handler — let the event loop breathe at
    // the outer loop boundaries so heartbeats/sockets on this worker don't stall.
    await new Promise((resolve) => setImmediate(resolve));
    const dayLoad = new Array(L).fill(0);
    const nightLoad = new Array(L).fill(0);
    const fijoOffsets = new Map<string, number>();
    let outOfBlock = 0;

    for (const st of ordered) {
      await new Promise((resolve) => setImmediate(resolve));
      const cycle = st.rot.dayShifts + st.rot.nightShifts + st.rot.restDays;
      if (cycle <= 0 || !st.fijos.length) continue;
      let bestO = 0, bestPen = Infinity, bestOob = 0;
      let bestAddDay: Record<number, number> = {}, bestAddNight: Record<number, number> = {};
      for (let o = 0; o < cycle; o++) {
        const fijoOffs = st.fijos.map((_, k) => ((o - k * st.rot.dayShifts) % cycle + cycle) % cycle);
        let pen = 0, oob = 0;
        const addDay: Record<number, number> = {}, addNight: Record<number, number> = {};
        for (let d = 0; d < L; d++) {
          const covered = new Set<string>();
          for (const f of fijoOffs) {
            const h = coveredHalf(st.scheduleType, getRotationStatus(d, f, st.rot.dayShifts, st.rot.nightShifts, st.rot.restDays));
            if (h) covered.add(h);
          }
          for (const half of requiredHalves(st.scheduleType)) {
            if (covered.has(half)) continue;
            if (half === 'day') {
              if (sfHalf(d, sfOff) === 'day') { pen += dayLoad[d] + (addDay[d] || 0); addDay[d] = (addDay[d] || 0) + 1; }
              else { pen += 1000; oob++; }
            } else {
              if (sfHalf(d, sfOff) === 'night') { pen += nightLoad[d] + (addNight[d] || 0); addNight[d] = (addNight[d] || 0) + 1; }
              else { pen += 1000; oob++; }
            }
          }
        }
        if (pen < bestPen) { bestPen = pen; bestO = o; bestOob = oob; bestAddDay = addDay; bestAddNight = addNight; }
      }
      const fijoOffs = st.fijos.map((_, k) => ((bestO - k * st.rot.dayShifts) % cycle + cycle) % cycle);
      st.fijos.forEach((f, k) => fijoOffsets.set(f.id, fijoOffs[k]));
      for (const d in bestAddDay) dayLoad[+d] += bestAddDay[+d];
      for (const d in bestAddNight) nightLoad[+d] += bestAddNight[+d];
      outOfBlock += bestOob;
    }

    let sfCount = 0;
    for (let d = 0; d < L; d++) {
      const h = sfHalf(d, sfOff);
      if (h === 'day') sfCount = Math.max(sfCount, dayLoad[d]);
      else if (h === 'night') sfCount = Math.max(sfCount, nightLoad[d]);
      // gaps on rest days were penalised as out-of-block; ensure they're counted too
      if (h === null) sfCount = Math.max(sfCount, dayLoad[d], nightLoad[d]);
    }
    if (dayLoad.some((v, d) => v > 0) || nightLoad.some((v, d) => v > 0)) sfCount = Math.max(sfCount, 1);

    const cand = { fijoOffsets, sfOffset: sfOff, sfCount, dayLoad, nightLoad, outOfBlock };
    if (!best || cand.outOfBlock < best.outOfBlock || (cand.outOfBlock === best.outOfBlock && cand.sfCount < best.sfCount)) {
      best = cand;
    }
  }

  const b = best!;
  return { fijoOffsets: b.fijoOffsets, sfOffset: b.sfOffset, sfCount: b.sfCount, L, dayLoad: b.dayLoad, nightLoad: b.nightLoad, outOfBlock: b.outOfBlock };
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
/** Thrown when an optimization is already running for the tenant (HTTP 409). */
export class SacafrancoOptimizeInProgressError extends Error {
  httpStatus = 409;
  constructor() {
    super('Ya hay una optimización de sacafrancos en curso para esta empresa. Espera a que termine e intenta de nuevo.');
    this.name = 'SacafrancoOptimizeInProgressError';
  }
}

// Per-tenant in-flight guard (module-level, per PM2 instance): a double-clicked
// "Optimizar" would otherwise run two interleaved tenant-wide force-destroy /
// recreate passes → duplicated or missing shifts + InnoDB lock waits.
const optimizeInFlightTenants = new Set<string>();

export async function optimizeSacafrancos(
  database: any,
  tenantId: string,
  userId: string,
  sacafrancoRotationStyleId?: string,
): Promise<{ message: string; details: any }> {
  if (optimizeInFlightTenants.has(tenantId)) {
    throw new SacafrancoOptimizeInProgressError();
  }
  optimizeInFlightTenants.add(tenantId);
  try {
    return await doOptimizeSacafrancos(database, tenantId, userId, sacafrancoRotationStyleId);
  } finally {
    optimizeInFlightTenants.delete(tenantId);
  }
}

async function doOptimizeSacafrancos(
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

  // 5. Resolve SF rotation style — default to 4-4-2 (the SF runs a real
  // day→night→rest rotation; it can never do a night then a day next morning).
  let sfRotationStyleId = sacafrancoRotationStyleId;
  if (!sfRotationStyleId) {
    const rot442 = await database.rotationStyle.findOne({ where: { name: '4-4-2', isSystem: true } });
    sfRotationStyleId = rot442?.id;
    if (!sfRotationStyleId) {
      const rot61 = await database.rotationStyle.findOne({ where: { name: '6-1', isSystem: true } });
      sfRotationStyleId = rot61?.id;
    }
    if (!sfRotationStyleId) {
      const anyRot = await database.rotationStyle.findOne({ where: { isSystem: true }, order: [['restDays', 'ASC']] });
      sfRotationStyleId = anyRot?.id;
    }
  }
  const sfRotation = await database.rotationStyle.findByPk(sfRotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
  if (!sfRotation) {
    return { message: 'No se encontró estilo de rotación para sacafrancos', details: {} };
  }

  // 6. Plan fijo offsets + the SF offset so a real day→night→rest SF covers every
  // gap feasibly (day-gaps land in the SF day-block, night-gaps in its night-block).
  const plan = await planStationsAndSf(spreadInfo, {
    dayShifts: sfRotation.dayShifts, nightShifts: sfRotation.nightShifts, restDays: sfRotation.restDays,
  });

  // Apply the chosen fijo offsets to positions + their active assignments.
  const offsetUpdates: { id: string; platoonOffset: number }[] = [];
  for (const [posId, off] of plan.fijoOffsets.entries()) {
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

  const numSfNeeded = plan.sfCount;
  const sfOffset = plan.sfOffset;
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
    // All SFs share the planned offset (same day→night→rest rotation); the
    // runtime splits each day's gaps among them by their index. Home station is
    // just where the position record lives (coverage is global).
    const stationId = stationsWithFijos[i % stationsWithFijos.length].stationId;
    targetSlots.push({
      index: i,
      stationId,
      startTime: '07:00',
      endTime: '19:00',
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

  // Sacafrancos are GLOBAL: a single SF is shared across ALL post sites and
  // stations and goes wherever the need is. So every SF's coveredStationIds is
  // the full set of fijo stations tenant-wide (not scoped to one sitio).
  const allFijoStationIds = stationsWithFijos.map((s) => s.stationId);

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
        coveredStationIds: allFijoStationIds,
        updatedById: userId,
      },
      { where: { id: a.id, tenantId } },
    );
  }

  // 9. Regenerate shifts for all fixed + active SF assignments after offset/position rebalance.
  // Lean attributes: exactly the AssignmentData fields generateShiftsForAssignment reads.
  const regenAttributes = [
    'id', 'guardId', 'stationId', 'positionId', 'rotationStyleId', 'startDate', 'endDate',
    'platoonOffset', 'isRelief', 'coveredStationIds', 'kind', 'startTime', 'endTime',
  ];
  const allFijoAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, positionId: fijoPositions.map((f: any) => f.id) },
    attributes: regenAttributes,
  });
  const allSfAssignments = await database.guardAssignment.findAll({
    where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
    attributes: regenAttributes,
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
    message: `Optimizado: ${targetSfCount} sacafranco(s) cubren ${stationsWithFijos.length} estaciones en cadena día→noche→libre.`,
    details: {
      totalStations: stationsWithFijos.length,
      sacafrancosNeeded: numSfNeeded,
      sacafrancosConfigured: targetSfCount,
      fijosNeeded: totalFijos,
      sfOffset,
      outOfBlockGaps: plan.outOfBlock,
      superCycleDays: plan.L,
      offsetsOptimized: offsetUpdates.length,
      rotationStyleId: sfRotationStyleId,
      sfAssignmentsPreserved: existingSfAssignments.length,
    },
  };
}
