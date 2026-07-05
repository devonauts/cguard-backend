/**
 * Supervisor turno math — derives the scheduled shift window(s) from a
 * supervisor's recurring turno config (turnoDays + turnoStart/turnoEnd, local
 * "HH:mm" in the tenant timezone). Used to stamp attendance at clock-in, drive
 * the supervisor forced-clock-out, and feed the app's schedule screen.
 *
 * Isolated from the guard scheduling engine on purpose (audit safety rule):
 * supervisors NEVER get guardAssignment/shift rows.
 */

const DEFAULT_TZ = 'America/Guayaquil';

interface TzParts { y: number; m: number; d: number; weekday: number; }

/** The tenant-local calendar parts (and weekday 0=Sun..6=Sat) of a UTC instant. */
function tzParts(date: Date, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const wk: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +map.year, m: +map.month, d: +map.day, weekday: wk[map.weekday] ?? 0 };
}

/** The tz offset (minutes tz is ahead of UTC) at a given instant. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour % 24, +map.minute, +map.second);
  return (asUTC - date.getTime()) / 60000;
}

/** UTC instant whose tenant-local wall clock is y-m-d hh:mm. DST-tolerant. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = tzOffsetMinutes(new Date(naive), tz);
  return new Date(naive - offset * 60000);
}

function parseHHmm(s: any): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const hh = +m[1], mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

export interface TurnoConfig {
  turnoDays?: number[] | null;
  turnoStart?: string | null;
  turnoEnd?: string | null;
}

export interface TurnoWindow {
  date: string;           // tenant-local YYYY-MM-DD the turno starts
  scheduledStart: Date;
  scheduledEnd: Date;
  shiftKind: string;      // Diurno | Nocturno | 24h
}

function classify(startHH: number, durationH: number): string {
  if (durationH >= 20) return '24h';
  if (startHH >= 18 || startHH < 5) return 'Nocturno';
  return 'Diurno';
}

/**
 * The turno window active for the given instant, or null if `now` doesn't fall
 * on a configured turno day. Handles overnight windows (end <= start → next day)
 * by also checking the previous day's window.
 */
export function turnoForInstant(cfg: TurnoConfig, now: Date, tz: string = DEFAULT_TZ): TurnoWindow | null {
  const days: number[] = Array.isArray(cfg.turnoDays) ? cfg.turnoDays.map(Number) : [];
  const start = parseHHmm(cfg.turnoStart);
  const end = parseHHmm(cfg.turnoEnd);
  if (!days.length || !start || !end) return null;

  const build = (p: TzParts): TurnoWindow => {
    const sStart = zonedToUtc(p.y, p.m, p.d, start.hh, start.mm, tz);
    let sEnd = zonedToUtc(p.y, p.m, p.d, end.hh, end.mm, tz);
    if (sEnd.getTime() <= sStart.getTime()) sEnd = new Date(sEnd.getTime() + 24 * 3600_000); // overnight
    const durationH = (sEnd.getTime() - sStart.getTime()) / 3600_000;
    return {
      date: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
      scheduledStart: sStart, scheduledEnd: sEnd, shiftKind: classify(start.hh, durationH),
    };
  };

  const today = tzParts(now, tz);
  // Today's window (if today is a turno day and now is within it, or before end).
  if (days.includes(today.weekday)) {
    const w = build(today);
    if (now.getTime() >= w.scheduledStart.getTime() - 6 * 3600_000 && now.getTime() <= w.scheduledEnd.getTime() + 6 * 3600_000) {
      return w;
    }
  }
  // Previous day's overnight window that may still be running now.
  const prevInstant = new Date(now.getTime() - 24 * 3600_000);
  const prev = tzParts(prevInstant, tz);
  if (days.includes(prev.weekday)) {
    const w = build(prev);
    if (now.getTime() >= w.scheduledStart.getTime() && now.getTime() <= w.scheduledEnd.getTime() + 6 * 3600_000) {
      return w;
    }
  }
  return null;
}

/** The next `count` turno windows from `from` (for the app schedule screen). */
export function upcomingTurnos(cfg: TurnoConfig, from: Date = new Date(), tz: string = DEFAULT_TZ, count = 7): TurnoWindow[] {
  const days: number[] = Array.isArray(cfg.turnoDays) ? cfg.turnoDays.map(Number) : [];
  const start = parseHHmm(cfg.turnoStart);
  const end = parseHHmm(cfg.turnoEnd);
  if (!days.length || !start || !end) return [];
  const out: TurnoWindow[] = [];
  for (let i = 0; i < 21 && out.length < count; i++) {
    const p = tzParts(new Date(from.getTime() + i * 24 * 3600_000), tz);
    if (!days.includes(p.weekday)) continue;
    const sStart = zonedToUtc(p.y, p.m, p.d, start.hh, start.mm, tz);
    let sEnd = zonedToUtc(p.y, p.m, p.d, end.hh, end.mm, tz);
    if (sEnd.getTime() <= sStart.getTime()) sEnd = new Date(sEnd.getTime() + 24 * 3600_000);
    if (sEnd.getTime() < from.getTime()) continue; // already over
    const durationH = (sEnd.getTime() - sStart.getTime()) / 3600_000;
    out.push({
      date: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
      scheduledStart: sStart, scheduledEnd: sEnd, shiftKind: classify(start.hh, durationH),
    });
  }
  return out;
}

export default { turnoForInstant, upcomingTurnos };
