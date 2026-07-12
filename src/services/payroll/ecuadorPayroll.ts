/**
 * Ecuadorian payroll engine — pure, dependency-free calculation.
 *
 * Turns a guard's monthly remuneration + worked-hour breakdown + rate into a
 * full rol de pagos: earnings (sueldo, horas suplementarias/extraordinarias,
 * recargo nocturno, décimos, fondos de reserva), deductions (aporte IESS
 * personal, impuesto a la renta, otros) and the employer's cost/provisions
 * (aporte patronal, provisiones de décimos, vacaciones, fondos). No DB, no
 * network — model on scheduleCostService.computeShiftsCost; tested in isolation.
 *
 * Statutory figures come from lib/ecuadorPayrollConstants.ts; hour-multipliers
 * can be overridden per tenant (nominaSettings).
 */
import {
  EcuadorStatutory,
  ecuadorStatutory,
  incomeTaxBrackets,
} from '../../lib/ecuadorPayrollConstants';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface PayrollWorkedHours {
  /** Ordinary hours worked (already inside the base salary — for reference). */
  regular?: number;
  /** Horas suplementarias (extra within the week, recargo 50%). */
  supplementary?: number;
  /** Horas extraordinarias (rest days / holidays, recargo 100%). */
  extraordinary?: number;
  /** Night hours eligible for recargo nocturno (25% surcharge). */
  night?: number;
}

export interface EcuadorPayrollInput {
  /** Monthly base salary (sueldo) in USD. Required. */
  monthlyRemuneration: number;
  /** Hourly rate for extra-hour surcharges. Defaults to monthlyRemuneration/240. */
  hourlyRate?: number;
  workedHours?: PayrollWorkedHours;
  /** Other IESS-taxable earnings this month (comisiones, bonos). */
  otherEarnings?: number;
  /** Other deductions (préstamos, anticipos, multas). */
  otherDeductions?: number;
  /** Completed years of service — fondos de reserva starts after the 1st year. */
  yearsOfService?: number;
  /** Pay décimos / fondos monthly (mensualizado) vs. accrue as employer provision. */
  decimoTerceroMensualizado?: boolean;
  decimoCuartoMensualizado?: boolean;
  fondosReservaMensualizado?: boolean;
  /**
   * Projected annual income-tax withholding for the year (optional). When >0 the
   * monthly retención = annual / 12. Pass 0/undefined to skip IR.
   */
  projectedAnnualIncomeTax?: number;
}

export interface EcuadorPayrollResult {
  currency: 'USD';
  earnings: {
    baseSalary: number;
    supplementaryPay: number;
    extraordinaryPay: number;
    nightSurcharge: number;
    decimoTercero: number;      // only when mensualizado, else 0 (see provisions)
    decimoCuarto: number;
    fondosReserva: number;
    other: number;
    /** IESS-taxable base (imponible): salary + hour pay + other; excludes décimos/fondos. */
    imponible: number;
    totalEarnings: number;
  };
  deductions: {
    iessPersonal: number;
    incomeTax: number;
    other: number;
    totalDeductions: number;
  };
  employerCost: {
    iessPatronal: number;
    decimoTerceroProvision: number;
    decimoCuartoProvision: number;
    fondosReservaProvision: number;
    vacacionesProvision: number;
    /** Gross earnings + all employer provisions/contributions. */
    totalCost: number;
  };
  /** Líquido a recibir = totalEarnings − totalDeductions. */
  netPay: number;
}

/**
 * Compute one month's rol de pagos for a guard.
 * @param input   the guard's month (salary, hours, rate, service years)
 * @param year    statutory year (SBU / IR table); defaults to latest known
 * @param overrides  tenant overrides for hour-multipliers / statutory figures
 */
export function computeEcuadorPayroll(
  input: EcuadorPayrollInput,
  year?: number,
  overrides: Partial<EcuadorStatutory> = {},
): EcuadorPayrollResult {
  const S = ecuadorStatutory(year, overrides);

  const baseSalary = Math.max(0, Number(input.monthlyRemuneration) || 0);
  // Ecuadorian convention: monthly salary ÷ 240 (30 days × 8h) for the hour value.
  const hourlyRate = input.hourlyRate != null ? Number(input.hourlyRate) : baseSalary / 240;
  const wh = input.workedHours || {};

  const supplementaryPay = round2((wh.supplementary || 0) * hourlyRate * S.supplementaryMultiplier);
  const extraordinaryPay = round2((wh.extraordinary || 0) * hourlyRate * S.extraordinaryMultiplier);
  const nightSurcharge = round2((wh.night || 0) * hourlyRate * S.nightSurchargePct);
  const other = Math.max(0, Number(input.otherEarnings) || 0);

  // IESS-taxable base (materia gravada): salary + hour pay + other earnings.
  // Décimos and fondos de reserva are NOT part of the imponible.
  const imponible = round2(baseSalary + supplementaryPay + extraordinaryPay + nightSurcharge + other);

  const eligibleFondos = (input.yearsOfService || 0) >= 1;
  const monthlyDecimoTercero = round2(imponible / 12);
  const monthlyDecimoCuarto = round2(S.sbu / 12);
  const monthlyFondos = eligibleFondos ? round2(imponible * S.fondosReserva) : 0;

  // Earnings that hit THIS month's pay depend on the mensualizado choices.
  const decimoTercero = input.decimoTerceroMensualizado ? monthlyDecimoTercero : 0;
  const decimoCuarto = input.decimoCuartoMensualizado ? monthlyDecimoCuarto : 0;
  const fondosReserva = input.fondosReservaMensualizado ? monthlyFondos : 0;

  const totalEarnings = round2(imponible + decimoTercero + decimoCuarto + fondosReserva);

  // Deductions.
  const iessPersonal = round2(imponible * S.iessPersonal);
  const incomeTax = round2(Math.max(0, Number(input.projectedAnnualIncomeTax) || 0) / 12);
  const otherDeductions = Math.max(0, Number(input.otherDeductions) || 0);
  const totalDeductions = round2(iessPersonal + incomeTax + otherDeductions);

  // Employer cost / provisions.
  const iessPatronal = round2(imponible * S.iessPatronal);
  // A provision only when NOT already paid to the employee this month.
  const decimoTerceroProvision = input.decimoTerceroMensualizado ? 0 : monthlyDecimoTercero;
  const decimoCuartoProvision = input.decimoCuartoMensualizado ? 0 : monthlyDecimoCuarto;
  const fondosReservaProvision = input.fondosReservaMensualizado ? 0 : monthlyFondos;
  // Vacaciones: 15 días/año ≈ imponible / 24 accrued monthly.
  const vacacionesProvision = round2((imponible * (S.vacationDaysPerYear / 360)));

  const totalCost = round2(
    totalEarnings +
      iessPatronal +
      decimoTerceroProvision +
      decimoCuartoProvision +
      fondosReservaProvision +
      vacacionesProvision,
  );

  const netPay = round2(totalEarnings - totalDeductions);

  return {
    currency: 'USD',
    earnings: {
      baseSalary: round2(baseSalary),
      supplementaryPay,
      extraordinaryPay,
      nightSurcharge,
      decimoTercero,
      decimoCuarto,
      fondosReserva,
      other: round2(other),
      imponible,
      totalEarnings,
    },
    deductions: {
      iessPersonal,
      incomeTax,
      other: round2(otherDeductions),
      totalDeductions,
    },
    employerCost: {
      iessPatronal,
      decimoTerceroProvision,
      decimoCuartoProvision,
      fondosReservaProvision,
      vacacionesProvision,
      totalCost,
    },
    netPay,
  };
}

/**
 * Progressive income-tax on a projected ANNUAL taxable base (renta imponible =
 * annual imponible − annual IESS personal, minus deductible expenses if any).
 * Returns the annual tax; divide by 12 for the monthly withholding.
 */
export function annualIncomeTax(annualTaxableBase: number, year?: number): number {
  const base = Math.max(0, Number(annualTaxableBase) || 0);
  const brackets = incomeTaxBrackets(year);
  let chosen = brackets[0];
  for (const b of brackets) {
    if (base >= b.base) chosen = b;
    else break;
  }
  return round2(chosen.basicTax + (base - chosen.base) * chosen.rate);
}
