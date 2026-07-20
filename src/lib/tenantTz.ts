/**
 * Tenant-timezone day-boundary helpers for reports. The prod server runs in UTC,
 * so building a date range with `setHours(0..23)` yields UTC midnights, not the
 * tenant's local day — which drops the last day's evening rows (e.g. after 19:00
 * in America/Guayaquil = UTC-5) and leaks early next-day rows. These compute the
 * exact UTC instants for the start/end of a LOCAL day in the tenant's timezone.
 *
 * Ecuador has no DST, but the offset is resolved per-date via Intl so this stays
 * correct for any tenant timezone.
 */

export const DEFAULT_TENANT_TZ = 'America/Guayaquil';

/** 'YYYY-MM-DD' for a Date rendered in the given timezone. */
export function localYmd(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

/** Minutes the timezone is ahead of UTC at the given instant (e.g. -300 for UTC-5). */
function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
    const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** UTC instant of 00:00:00 local time for the given 'YYYY-MM-DD' in tz. */
export function zonedDayStartUtc(ymd: string, tz: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60000);
}

/** Resolves a from/to query (date strings or ISO) to the exact UTC window covering
 *  those LOCAL days [from 00:00:00 … to 23:59:59.999] in the tenant timezone. */
export function tenantDayRange(
  fromInput: any,
  toInput: any,
  tz: string,
  opts: { defaultSpanDays?: number } = {},
): { from: Date; to: Date } {
  const span = opts.defaultSpanDays ?? 30;
  const now = new Date();

  const ymdOf = (input: any, fallback: Date): string => {
    if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);
    const d = input ? new Date(String(input)) : null;
    return localYmd(d && !Number.isNaN(d.getTime()) ? d : fallback, tz);
  };

  const toYmd = ymdOf(toInput, now);
  const defaultFrom = new Date(now.getTime() - span * 86400000);
  const fromYmd = ymdOf(fromInput, defaultFrom);

  const from = zonedDayStartUtc(fromYmd, tz);
  // End = start of the day AFTER toYmd, minus 1ms (DST-safe inclusive end-of-day).
  const nextDay = new Date(zonedDayStartUtc(toYmd, tz).getTime() + 86400000 + 6 * 3600000);
  const toEnd = new Date(zonedDayStartUtc(localYmd(nextDay, tz), tz).getTime() - 1);

  return { from, to: toEnd };
}

/** Fetches the tenant's configured timezone, defaulting to America/Guayaquil. */
export async function getTenantTz(db: any, tenantId: string): Promise<string> {
  try {
    const tnt = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    if (tnt?.timezone) return String(tnt.timezone);
  } catch { /* default */ }
  return DEFAULT_TENANT_TZ;
}
