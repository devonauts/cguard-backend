/**
 * Shared engine for every "Horario" D/N/L grid in the CRM.
 *
 * Three screens render the same rotation grid and MUST agree cell-for-cell:
 *   1. Programador › Horario          (/scheduler/overview)
 *   2. Cliente › Estaciones y cobertura (/client-account/:id/schedule)
 *   3. Vigilante › Horario            (/security-guard/:id/schedule)
 *
 * They used to each re-derive the rotation from `rotationStyle` math. That drifted
 * from reality in two ways:
 *   - A station with no `rotationStyleId` fell back to 'rest' for EVERY day, so a
 *     sede full of turnos rendered as a blank wall of "L".
 *   - The formula can't see a sacafranco covering someone, an ad-hoc turno, or a
 *     manually deleted one — none of those live in the rotation cycle.
 *
 * The generated `shift` rows are the single source of truth (written a year ahead
 * by shiftGenerationService). This module paints from those, and keeps the
 * rotation math only to tell a legitimate libre day apart from a missing turno.
 */

// Must match shiftGenerationService.ROTATION_EPOCH.
export const ROTATION_EPOCH = Date.UTC(2024, 0, 1);

export type CellStatus = 'day' | 'night' | 'rest' | 'gap' | 'none';

export interface GridCell {
  date: string;
  status: CellStatus;
  hours: string | null;      // real turno window in tenant tz, e.g. "07:00 - 19:00"
  guardName: string | null;  // who actually covers that day
  covering: boolean;         // true when that isn't the row's titular vigilante
}

export interface GridDay {
  date: string; dow: string; day: number; isToday: boolean; weekend: boolean;
}

export const dseOf = (d: Date) =>
  Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ROTATION_EPOCH) / 86400000);

export const rotationStatus = (
  dse: number, platoonOffset: number, dayShifts: number, nightShifts: number, restDays: number,
): 'day' | 'night' | 'rest' => {
  const cycle = Math.max(1, dayShifts + nightShifts + restDays);
  const a = (((dse - platoonOffset) % cycle) + cycle) % cycle;
  if (a < dayShifts) return 'day';
  if (a < dayShifts + nightShifts) return 'night';
  return 'rest';
};

export const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

export const parseYmd = (s: any, fb: Date) => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return fb;
};

/**
 * A shift's calendar day and clock time must be read in the TENANT's timezone.
 * A 19:00–07:00 turno in Guayaquil is stored as 00:00 UTC the NEXT day, so UTC
 * bucketing files every night shift under the wrong column.
 */
export const tzParts = (d: Date, tz: string) => {
  const p: any = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a: any, x) => (a[x.type] = x.value, a), {});
  const hour = Number(p.hour) % 24; // some ICU builds emit '24' at midnight
  return { date: `${p.year}-${p.month}-${p.day}`, hour, hhmm: `${String(hour).padStart(2, '0')}:${p.minute}` };
};

export async function tenantTz(db: any, tenantId: string): Promise<string> {
  try {
    const t = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    return (t && t.timezone) || 'UTC';
  } catch { return 'UTC'; }
}

const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Day columns for [start, end], flagging today in the tenant's timezone. */
export function buildDays(start: Date, end: Date, todayStr: string): GridDay[] {
  const days: GridDay[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    days.push({
      date: ymd(d), dow: DOW[d.getUTCDay()], day: d.getUTCDate(),
      isToday: ymd(d) === todayStr,
      weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    });
  }
  return days;
}

/**
 * Resolve the requested window, defaulting to today..+13d in tenant time and
 * capping the span at 31 days so a hand-crafted query can't ask for a year.
 */
export function resolveWindow(query: any, todayStr: string) {
  const todayUtc = parseYmd(todayStr, new Date());
  const start = parseYmd(query?.startDate, todayUtc);
  let end = parseYmd(query?.endDate, new Date(start.getTime() + 13 * 86400000));
  if (end < start) end = new Date(start.getTime() + 13 * 86400000);
  if ((end.getTime() - start.getTime()) / 86400000 > 31) end = new Date(start.getTime() + 31 * 86400000);
  return { start, end };
}

const guardLabel = (u: any) =>
  u ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Vigilante') : null;

export interface ShiftIndex {
  byPosDate: Map<string, any>;
  byGuardStationDate: Map<string, any>;
}

/**
 * Load the real generated turnos for `stationIds` and index them for O(1) cell
 * lookup. The window is padded ±1 day because an overnight turno starting 19:00
 * local on the last column is stored in UTC on the following day.
 */
export async function loadShiftIndex(
  db: any, tenantId: string, stationIds: string[], start: Date, end: Date, tz: string,
): Promise<ShiftIndex> {
  const byPosDate = new Map<string, any>();
  const byGuardStationDate = new Map<string, any>();
  if (!stationIds.length) return { byPosDate, byGuardStationDate };

  const Op = db.Sequelize.Op;
  const rows = await db.shift.findAll({
    where: {
      tenantId, stationId: stationIds, deletedAt: null,
      startTime: { [Op.gte]: new Date(start.getTime() - 86400000), [Op.lt]: new Date(end.getTime() + 2 * 86400000) },
    },
    attributes: ['id', 'guardId', 'stationId', 'positionId', 'startTime', 'endTime'],
    include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
    order: [['startTime', 'ASC']],
  }).catch(() => []);

  for (const sh of rows) {
    const { date, hhmm, hour } = tzParts(new Date(sh.startTime), tz);
    const endLocal = tzParts(new Date(sh.endTime), tz);
    const entry = {
      status: (hour >= 18 || hour < 6) ? 'night' : 'day',
      hours: `${hhmm} - ${endLocal.hhmm}`,
      guardId: sh.guardId ? String(sh.guardId) : null,
      guardName: guardLabel(sh.guard),
    };
    // Shifts predating the positionId column carry null, hence the guard+station
    // fallback key — every caller can build at least one of the two.
    if (sh.positionId) byPosDate.set(`${sh.positionId}|${date}`, entry);
    if (sh.guardId) byGuardStationDate.set(`${sh.guardId}|${sh.stationId}|${date}`, entry);
  }
  return { byPosDate, byGuardStationDate };
}

export interface PaintOptions {
  positionId?: string | null;
  stationId?: string | null;
  /** The row's titular vigilante — used to detect a sacafranco covering. */
  guardId?: string | null;
  /** Station rotation style, when configured. */
  rot?: { dayShifts?: any; nightShifts?: any; restDays?: any } | null;
  platoon?: number;
}

/**
 * Paint one row's cells. Precedence:
 *   1. A real generated turno always wins — this is what Programador shows.
 *   2. No turno on a slot WITH a rotation → 'rest' if the cycle expected a libre,
 *      'gap' if it expected work (a genuine hole in coverage, which the old
 *      'rest' fallback disguised).
 *   3. No turno and no rotation → 'none'. Nothing is scheduled; saying "libre"
 *      there was a lie.
 */
export function paintCells(days: GridDay[], index: ShiftIndex, opts: PaintOptions): GridCell[] {
  const { positionId, stationId, guardId, rot, platoon = 0 } = opts;
  return days.map((d) => {
    const real =
      (positionId ? index.byPosDate.get(`${positionId}|${d.date}`) : null) ||
      (guardId && stationId ? index.byGuardStationDate.get(`${guardId}|${stationId}|${d.date}`) : null);

    if (real) {
      return {
        date: d.date,
        status: real.status as CellStatus,
        hours: real.hours,
        guardName: real.guardName,
        covering: !!(guardId && real.guardId && real.guardId !== String(guardId)),
      };
    }
    if (rot) {
      const expected = rotationStatus(
        dseOf(new Date(`${d.date}T00:00:00Z`)), platoon,
        Number(rot.dayShifts) || 0, Number(rot.nightShifts) || 0, Number(rot.restDays) || 0,
      );
      return { date: d.date, status: expected === 'rest' ? 'rest' : 'gap', hours: null, guardName: null, covering: false };
    }
    return { date: d.date, status: 'none', hours: null, guardName: null, covering: false };
  });
}
