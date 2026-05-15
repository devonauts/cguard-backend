/**
 * GET /tenant/:tenantId/post-site/:id/coverage-gaps?from=ISO&to=ISO
 *
 * For each station in the post-site, computes uncovered time blocks
 * within the station's declared operating window (startingTimeInDay–finishTimeInDay)
 * across the requested date range.
 *
 * Response:
 * {
 *   from: ISO,
 *   to: ISO,
 *   stations: [{
 *     id, stationName, numberOfGuardsInStation,
 *     startingTimeInDay, finishTimeInDay,
 *     coverageScore: 0–100,          // % of required window that IS covered
 *     gaps: [{ day: "YYYY-MM-DD", startTime: ISO, endTime: ISO, hoursUncovered: number }]
 *     coveredPeriods: [{ day, startTime, endTime }]
 *   }]
 * }
 */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

interface Interval {
  start: number; // ms timestamp
  end: number;
}

/** Merge overlapping/adjacent intervals (sorted by start) */
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** Subtract covered intervals from required window → returns gap intervals */
function subtractIntervals(windowStart: number, windowEnd: number, covered: Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = windowStart;
  for (const cv of covered) {
    if (cv.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(cv.start, windowEnd) });
    }
    cursor = Math.max(cursor, cv.end);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) {
    gaps.push({ start: cursor, end: windowEnd });
  }
  return gaps;
}

/** Parse "HH:MM" → { h, m } */
function parseHHMM(hhmm: string | null | undefined): { h: number; m: number } | null {
  if (!hhmm) return null;
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr ?? '0', 10);
  if (isNaN(h) || isNaN(m)) return null;
  return { h, m };
}

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);

    const { tenantId, id: postSiteId } = req.params;
    const db = req.database;

    // Date range defaults: today → today+6 (one week)
    const fromDate = req.query.from ? new Date(req.query.from as string) : (() => {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d;
    })();
    const toDate = req.query.to ? new Date(req.query.to as string) : (() => {
      const d = new Date(fromDate); d.setDate(d.getDate() + 6); d.setHours(23, 59, 59, 999); return d;
    })();

    // ── 1. Stations for this post site ──────────────────────────────────────
    const stationsRaw = await db.station.findAll({
      where: { postSiteId, tenantId, deletedAt: null },
      attributes: ['id', 'stationName', 'numberOfGuardsInStation', 'startingTimeInDay', 'finishTimeInDay'],
      order: [['stationName', 'ASC']],
    });

    if (!stationsRaw.length) {
      return ApiResponseHandler.success(req, res, {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        stations: [],
      });
    }

    const stationIds: string[] = stationsRaw.map((s: any) => s.id);

    // ── 2. All shifts for these stations in the date range ───────────────────
    const shiftsRaw = await db.shift.findAll({
      where: {
        tenantId,
        stationId: stationIds,
        startTime: { [db.Sequelize.Op.lte]: toDate },
        endTime:   { [db.Sequelize.Op.gte]: fromDate },
        deletedAt: null,
      },
      attributes: ['id', 'stationId', 'guardId', 'startTime', 'endTime'],
    });

    // Group shifts by stationId
    const shiftsByStation = new Map<string, Array<{ start: number; end: number }>>();
    for (const station of stationsRaw) {
      shiftsByStation.set(station.id, []);
    }
    for (const sh of shiftsRaw) {
      const bucket = shiftsByStation.get(sh.stationId);
      if (bucket) {
        bucket.push({
          start: new Date(sh.startTime).getTime(),
          end:   new Date(sh.endTime).getTime(),
        });
      }
    }

    // ── 3. Build day list ────────────────────────────────────────────────────
    const days: string[] = [];
    const cursor = new Date(fromDate);
    cursor.setHours(0, 0, 0, 0);
    const toDay = new Date(toDate);
    toDay.setHours(0, 0, 0, 0);
    while (cursor <= toDay) {
      days.push(cursor.toISOString().slice(0, 10)); // "YYYY-MM-DD"
      cursor.setDate(cursor.getDate() + 1);
    }

    // ── 4. Per-station coverage analysis ────────────────────────────────────
    const stationResults = stationsRaw.map((station: any) => {
      const stationShifts = shiftsByStation.get(station.id) ?? [];

      // Parse operating window from station fields
      // Default: 00:00 – 24:00 (full day) if not set
      const startParsed = parseHHMM(station.startingTimeInDay) ?? { h: 0, m: 0 };
      const endParsed   = parseHHMM(station.finishTimeInDay)   ?? { h: 24, m: 0 };

      // Determine if it's a 24h operation
      const is24h = (startParsed.h === 0 && startParsed.m === 0 && endParsed.h === 24 && endParsed.m === 0) ||
                    station.finishTimeInDay === null || station.startingTimeInDay === null;

      const requiredHoursPerDay = is24h ? 24 : ((endParsed.h * 60 + endParsed.m) - (startParsed.h * 60 + startParsed.m)) / 60;

      let totalRequiredMs  = 0;
      let totalCoveredMs   = 0;
      const allGaps: Array<{ day: string; startTime: string; endTime: string; hoursUncovered: number }> = [];
      const allCovered: Array<{ day: string; startTime: string; endTime: string }> = [];

      for (const day of days) {
        // Window for this day
        const dayDate = new Date(day + 'T00:00:00');

        let windowStart: number;
        let windowEnd: number;

        if (is24h) {
          windowStart = dayDate.getTime();
          windowEnd   = dayDate.getTime() + 24 * 60 * 60 * 1000;
        } else {
          windowStart = dayDate.getTime() + (startParsed.h * 60 + startParsed.m) * 60 * 1000;
          windowEnd   = dayDate.getTime() + (endParsed.h   * 60 + endParsed.m)   * 60 * 1000;
          // Handle overnight (e.g., 20:00–06:00)
          if (windowEnd <= windowStart) windowEnd += 24 * 60 * 60 * 1000;
        }

        totalRequiredMs += windowEnd - windowStart;

        // Filter shifts that overlap this window
        const dayIntervals: Interval[] = stationShifts
          .filter(s => s.end > windowStart && s.start < windowEnd)
          .map(s => ({
            start: Math.max(s.start, windowStart),
            end:   Math.min(s.end,   windowEnd),
          }));

        const merged = mergeIntervals(dayIntervals);
        const coveredMs = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
        totalCoveredMs += coveredMs;

        // Covered periods
        for (const cv of merged) {
          allCovered.push({
            day,
            startTime: new Date(cv.start).toISOString(),
            endTime:   new Date(cv.end).toISOString(),
          });
        }

        // Gaps
        if (requiredHoursPerDay > 0) {
          const gaps = subtractIntervals(windowStart, windowEnd, merged);
          for (const gap of gaps) {
            const hoursUncovered = Math.round((gap.end - gap.start) / (1000 * 60 * 60) * 10) / 10;
            if (hoursUncovered > 0) {
              allGaps.push({
                day,
                startTime:      new Date(gap.start).toISOString(),
                endTime:        new Date(gap.end).toISOString(),
                hoursUncovered,
              });
            }
          }
        }
      }

      const coverageScore = totalRequiredMs > 0
        ? Math.round((totalCoveredMs / totalRequiredMs) * 100)
        : 100;

      return {
        id:                    station.id,
        stationName:           station.stationName,
        numberOfGuardsInStation: station.numberOfGuardsInStation,
        startingTimeInDay:     station.startingTimeInDay,
        finishTimeInDay:       station.finishTimeInDay,
        is24h,
        requiredHoursPerDay,
        coverageScore,
        gaps:           allGaps,
        coveredPeriods: allCovered,
      };
    });

    return ApiResponseHandler.success(req, res, {
      from:     fromDate.toISOString(),
      to:       toDate.toISOString(),
      stations: stationResults,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
