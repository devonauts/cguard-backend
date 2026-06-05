/**
 * Recurrence helpers for station "consignas" — TENANT-TIMEZONE aware.
 *
 * A consigna's `time` and recurrence are interpreted in the tenant's IANA
 * timezone (tenant.timezone), not the server's local time. All functions take a
 * `tz` (defaults to 'UTC'); occurrences and due-times are computed against the
 * tenant's wall clock.
 */

function parseDays(raw: any): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') { try { return JSON.parse(raw).map(Number); } catch { return []; } }
  return [];
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock components of an instant as seen in `tz`. */
function parts(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p: any = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour, mi: +p.minute, s: +p.second,
    dow: WEEKDAY[p.weekday] ?? new Date(date).getUTCDay(),
  };
}

/** Milliseconds `tz` is ahead of UTC at the given instant. */
function tzOffsetMs(tz: string, date: Date): number {
  const p = parts(date, tz);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUTC - date.getTime();
}

/** UTC Date for a wall-clock (y,mo,d,h,mi) in `tz`. (Single pass; exact for non-DST zones.) */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

/** Tenant-local date string YYYY-MM-DD for `date`. */
export function ymd(date: Date, tz = 'UTC'): string {
  const p = parts(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Is the consigna due on `date` (evaluated in the tenant's timezone)? */
export function isDueOn(order: any, date: Date, tz = 'UTC'): boolean {
  const p = parts(date, tz);
  switch (order.recurrence) {
    case 'daily': return true;
    case 'weekdays': return p.dow >= 1 && p.dow <= 5;
    case 'weekend': return p.dow === 0 || p.dow === 6;
    case 'weekly': return parseDays(order.days).includes(p.dow);
    case 'monthly': return Number(order.dayOfMonth) === p.d;
    case 'once': return order.date ? String(order.date).slice(0, 10) === ymd(date, tz) : false;
    default: return false;
  }
}

/** The UTC instant of today's occurrence (tenant-local date + order.time). */
export function dueAt(order: any, date: Date, tz = 'UTC'): Date {
  const p = parts(date, tz);
  const [h, mi] = String(order.time || '00:00').split(':').map((x: string) => parseInt(x, 10) || 0);
  return zonedToUtc(p.y, p.mo, p.d, h, mi, tz);
}
