/**
 * Recurrence helpers for station "consignas". A consigna defines a pattern
 * (daily/weekdays/weekend/weekly/monthly/once) + an optional time; these helpers
 * resolve whether an occurrence falls on a given local date and its due Date.
 */

function parseDays(raw: any): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') { try { return JSON.parse(raw).map(Number); } catch { return []; } }
  return [];
}

/** Is this consigna due on the given date (local day)? */
export function isDueOn(order: any, date: Date): boolean {
  const dow = date.getDay(); // 0 Sun .. 6 Sat
  switch (order.recurrence) {
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekend': return dow === 0 || dow === 6;
    case 'weekly': return parseDays(order.days).includes(dow);
    case 'monthly': return Number(order.dayOfMonth) === date.getDate();
    case 'once': {
      if (!order.date) return false;
      const d = new Date(order.date as any);
      return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
    }
    default: return false;
  }
}

/** YYYY-MM-DD for a local date. */
export function ymd(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** The due Date for today's occurrence (combines date + order.time, default 00:00). */
export function dueAt(order: any, date: Date): Date {
  const [h, m] = String(order.time || '00:00').split(':').map((x: string) => parseInt(x, 10) || 0);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}
