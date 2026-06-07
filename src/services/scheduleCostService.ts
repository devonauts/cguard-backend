/**
 * Deterministic schedule COST model (Phase 5 — req 5: save money).
 *
 * Replaces the LLM "estimatedCost" prose with a real, explainable dollar figure:
 * regular vs overtime hours, plus a night surcharge (recargo nocturno). Rates
 * come from the tenant's nómina/payroll settings (per-guard overrides supported).
 * If no hourly rate is configured the model reports hours only (hasRate=false).
 */
import { getNominaSettings } from '../lib/nominaSettings';

export interface CostSettings {
  currency: string;
  defaultHourlyRate: number;
  overtimeThresholdHours: number;
  overtimeMultiplier: number;
  nightSurchargePct: number;
  nightStartHour: number;
  nightEndHour: number;
  guardRates: Record<string, number>;
}

export interface ShiftForCost {
  guardId?: string | null;
  startTime: Date | string;
  endTime: Date | string;
}

export interface CostResult {
  currency: string;
  hasRate: boolean;
  totalCost: number;
  regularHours: number;
  overtimeHours: number;
  nightHours: number;
  shiftCount: number;
}

export async function getCostSettings(db: any, tenantId: string): Promise<CostSettings> {
  const s: any = await getNominaSettings(db, tenantId);
  const p = s?.payroll || {};
  return {
    currency: p.currency || 'USD',
    defaultHourlyRate: Number(p.defaultHourlyRate) || 0,
    overtimeThresholdHours: Number(p.overtimeThresholdHours) || 8,
    overtimeMultiplier: Number(p.overtimeMultiplier) || 1.5,
    nightSurchargePct: Number(p.nightSurchargePct) || 0,
    nightStartHour: Number(p.nightStartHour ?? 19),
    nightEndHour: Number(p.nightEndHour ?? 6),
    guardRates: p.guardRates || {},
  };
}

/** Local hour (0-23) of a UTC instant in the tenant timezone. */
function localHour(d: Date, tz: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : d.getUTCHours();
  } catch {
    return d.getUTCHours();
  }
}

/**
 * Cost a set of shifts. Per shift: hours up to the overtime threshold are paid
 * at the (per-guard or default) rate; hours beyond at rate × overtimeMultiplier.
 * A shift that begins inside the night window adds nightSurchargePct of the base
 * rate on its hours (coarse but deterministic; matches the 12h D/N shift shape).
 */
export function computeShiftsCost(shifts: ShiftForCost[], settings: CostSettings, tz: string): CostResult {
  const guardRateValues = Object.values(settings.guardRates || {}).map((r) => Number(r));
  const hasRate = settings.defaultHourlyRate > 0 || guardRateValues.some((r) => r > 0);

  let regularHours = 0;
  let overtimeHours = 0;
  let nightHours = 0;
  let totalCost = 0;

  for (const sh of shifts) {
    const start = new Date(sh.startTime);
    const end = new Date(sh.endTime);
    const ms = end.getTime() - start.getTime();
    if (!(ms > 0)) continue;
    const hours = ms / 3_600_000;
    const rate = Number(settings.guardRates?.[String(sh.guardId)]) || settings.defaultHourlyRate;

    const reg = Math.min(hours, settings.overtimeThresholdHours);
    const ot = Math.max(0, hours - settings.overtimeThresholdHours);

    const startHour = localHour(start, tz);
    const isNight = startHour >= settings.nightStartHour || startHour < settings.nightEndHour;
    const nh = isNight ? hours : 0;

    regularHours += reg;
    overtimeHours += ot;
    nightHours += nh;
    totalCost += reg * rate + ot * rate * settings.overtimeMultiplier + nh * rate * settings.nightSurchargePct;
  }

  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    currency: settings.currency,
    hasRate,
    totalCost: round(totalCost),
    regularHours: round(regularHours, 1),
    overtimeHours: round(overtimeHours, 1),
    nightHours: round(nightHours, 1),
    shiftCount: shifts.length,
  };
}
