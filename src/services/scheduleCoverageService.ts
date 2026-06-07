/**
 * Real coverage analyzer (Phase 7 — the backbone of "guaranteed coverage").
 *
 * Given the PERSISTED/proposed shifts and each station's coverage requirement
 * (derived from scheduleType: 24h ⇒ day+night, 12h-day ⇒ day, 12h-night ⇒
 * night), it asserts that EVERY (station, local-day, turno-half) slot has exactly
 * one guard. Slots with 0 are GAPS (a puesto is empty); slots with >1 are
 * OVERSTAFF (wasted money). This is computed from real shift rows — never from a
 * client-side rotation recompute — so the admin grid, publish gate, and worker-
 * app can all agree on one truth.
 */
export type TurnoHalf = 'day' | 'night';

export interface CoverageShift {
  stationId?: string | null;
  guardId?: string | null;
  startTime: Date | string;
}

export interface StationReq {
  stationId: string;
  stationName?: string | null;
  halves: TurnoHalf[];
}

export interface CoverageSlot {
  stationId: string;
  stationName?: string | null;
  date: string;
  half: TurnoHalf;
  count: number;
}

export interface CoverageResult {
  windowDays: number;
  required: number;
  covered: number;
  coveredPct: number;
  gapCount: number;
  overstaffCount: number;
  gaps: CoverageSlot[];
  overstaff: CoverageSlot[];
}

/** Coverage halves a station requires, from its scheduleType. */
export function requiredHalves(scheduleType?: string | null): TurnoHalf[] {
  switch (scheduleType) {
    case '24h':
      return ['day', 'night'];
    case '12h-night':
      return ['night'];
    case '12h-day':
      return ['day'];
    default:
      return ['day']; // custom/unconfigured → a single day slot (conservative)
  }
}

/** Local hour (0-23) of an instant in the tenant timezone. */
function localHour(d: Date, tz: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : d.getUTCHours();
  } catch {
    return d.getUTCHours();
  }
}

/** Local calendar date (YYYY-MM-DD) of an instant in the tenant timezone. */
function localDate(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

/** A shift counts toward the day half if it starts 06:00–18:59 local, else night. */
export function classifyHalf(startTime: Date | string, tz: string): TurnoHalf {
  const h = localHour(new Date(startTime), tz);
  return h >= 18 || h < 6 ? 'night' : 'day';
}

export function computeCoverage(
  shifts: CoverageShift[],
  stations: StationReq[],
  windowStart: Date,
  windowDays: number,
  tz: string,
): CoverageResult {
  // Tally guards per (station, local-day, half).
  const counts = new Map<string, number>();
  for (const s of shifts) {
    if (!s.stationId) continue;
    const date = localDate(new Date(s.startTime), tz);
    const half = classifyHalf(s.startTime, tz);
    const key = `${s.stationId}|${date}|${half}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const gaps: CoverageSlot[] = [];
  const overstaff: CoverageSlot[] = [];
  let required = 0;
  let covered = 0;

  for (let d = 0; d < windowDays; d++) {
    // Anchor at local noon so the date is stable regardless of tz offset.
    const anchor = new Date(windowStart.getTime() + d * 86_400_000 + 12 * 3_600_000);
    const date = localDate(anchor, tz);
    for (const st of stations) {
      for (const half of st.halves) {
        required++;
        const c = counts.get(`${st.stationId}|${date}|${half}`) || 0;
        if (c >= 1) covered++;
        if (c === 0) gaps.push({ stationId: st.stationId, stationName: st.stationName, date, half, count: 0 });
        else if (c > 1) overstaff.push({ stationId: st.stationId, stationName: st.stationName, date, half, count: c });
      }
    }
  }

  return {
    windowDays,
    required,
    covered,
    coveredPct: required ? Math.round((covered / required) * 100) : 100,
    gapCount: gaps.length,
    overstaffCount: overstaff.length,
    gaps,
    overstaff,
  };
}
