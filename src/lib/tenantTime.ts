/**
 * Tenant-timezone time helpers — the single source of truth for interpreting
 * and rendering wall-clock times. Shift/schedule times are entered as wall-clock
 * in the tenant's timezone (tenant.timezone, derived from the tenant address)
 * and stored as true UTC. Display always formats UTC back into the tenant tz, so
 * the time is correct regardless of the viewer's device timezone.
 */

/** Offset (minutes) of `tz` from UTC at instant `at`. America/Guayaquil → -300. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts: any = {};
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
    const asUTC = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour, +parts.minute, +parts.second,
    );
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Interpret a wall-clock (`YYYY-MM-DD`, `HH:mm`) in `tz` and return the true UTC
 * Date. e.g. 07:00 America/Guayaquil → 12:00Z.
 */
export function wallClockToUtc(dateStr: string, hhmm: string, tz: string): Date {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const wallAsUtcMs = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  // utc = wall - offset; refine once for DST boundaries.
  let off = tzOffsetMinutes(tz, new Date(wallAsUtcMs));
  let realMs = wallAsUtcMs - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(realMs));
  if (off2 !== off) realMs = wallAsUtcMs - off2 * 60000;
  return new Date(realMs);
}

/** Format a UTC date as `HH:mm` in the tenant timezone. */
export function timeLabelInTz(date: Date | string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('es', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz,
    }).format(new Date(date));
  } catch {
    return '';
  }
}

const COUNTRY_TZ: Record<string, string> = {
  ecuador: 'America/Guayaquil', ec: 'America/Guayaquil',
  colombia: 'America/Bogota', co: 'America/Bogota',
  peru: 'America/Lima', 'perú': 'America/Lima', pe: 'America/Lima',
  mexico: 'America/Mexico_City', 'méxico': 'America/Mexico_City', mx: 'America/Mexico_City',
  panama: 'America/Panama', 'panamá': 'America/Panama', pa: 'America/Panama',
  chile: 'America/Santiago', cl: 'America/Santiago',
  argentina: 'America/Argentina/Buenos_Aires', ar: 'America/Argentina/Buenos_Aires',
  venezuela: 'America/Caracas', ve: 'America/Caracas',
  bolivia: 'America/La_Paz', bo: 'America/La_Paz',
  'costa rica': 'America/Costa_Rica', cr: 'America/Costa_Rica',
  guatemala: 'America/Guatemala', gt: 'America/Guatemala',
  'united states': 'America/New_York', usa: 'America/New_York', us: 'America/New_York',
  spain: 'Europe/Madrid', 'españa': 'Europe/Madrid', es: 'Europe/Madrid',
};

/** Best-effort IANA timezone for a country name/code (defaults to UTC). */
export function timezoneForCountry(country?: string | null): string {
  if (!country) return 'UTC';
  return COUNTRY_TZ[String(country).trim().toLowerCase()] || 'UTC';
}
