/**
 * Ecuadorian statutory payroll constants.
 *
 * Values change by year (SBU, IR brackets) so they're keyed by year with a
 * "latest known" fallback. IESS/fondos percentages have been stable for years.
 * These are DEFAULTS — a tenant's nominaSettings can still override the
 * hour-multipliers; the statutory percentages here are the legal figures.
 *
 * Sources: Código del Trabajo (Ecuador), Ley de Seguridad Social (IESS).
 * Keep this file updated each January when the government fixes the new SBU.
 */

/** Salario Básico Unificado (monthly minimum wage) by year, USD. */
export const SBU_BY_YEAR: Record<number, number> = {
  2023: 450,
  2024: 460,
  2025: 470,
};
export const LATEST_SBU_YEAR = 2025;

export function sbuForYear(year?: number): number {
  const y = year && SBU_BY_YEAR[year] ? year : LATEST_SBU_YEAR;
  return SBU_BY_YEAR[y];
}

export interface EcuadorStatutory {
  /** Employee IESS contribution (aporte personal), fraction. */
  iessPersonal: number;
  /** Employer IESS contribution (aporte patronal), fraction. */
  iessPatronal: number;
  /** Fondos de reserva rate (one month's salary spread over the year), fraction. */
  fondosReserva: number;
  /** Salario Básico Unificado for the décimo cuarto base. */
  sbu: number;
  /** Días de vacaciones per year (Código del Trabajo art. 69: 15 base). */
  vacationDaysPerYear: number;
  /** Hour surcharges — legal Ecuadorian defaults, overridable per tenant. */
  supplementaryMultiplier: number; // horas suplementarias — recargo 50% ⇒ 1.5×
  extraordinaryMultiplier: number; // horas extraordinarias — recargo 100% ⇒ 2×
  nightSurchargePct: number;       // recargo nocturno — 25% sobre la hora ordinaria
}

/** Legal defaults for the current year. */
export function ecuadorStatutory(year?: number, overrides: Partial<EcuadorStatutory> = {}): EcuadorStatutory {
  return {
    iessPersonal: 0.0945,      // 9.45%
    iessPatronal: 0.1115,      // 11.15% (general private sector)
    fondosReserva: 0.0833,     // 8.33% (1/12 of a month's salary)
    sbu: sbuForYear(year),
    vacationDaysPerYear: 15,
    supplementaryMultiplier: 1.5,
    extraordinaryMultiplier: 2,
    nightSurchargePct: 0.25,
    ...overrides,
  };
}

/**
 * Impuesto a la Renta — annual withholding brackets for personas naturales en
 * relación de dependencia (Tabla del Art. 36 LRTI). Amounts in USD. `base` is
 * the lower bound of the fracción básica; tax = basicTax + (income − base) × rate.
 * 2024 table (SRI). Update yearly.
 */
export interface IncomeTaxBracket { base: number; basicTax: number; rate: number; }
export const INCOME_TAX_BRACKETS_BY_YEAR: Record<number, IncomeTaxBracket[]> = {
  2024: [
    { base: 0,       basicTax: 0,       rate: 0 },
    { base: 11902,   basicTax: 0,       rate: 0.05 },
    { base: 15159,   basicTax: 163,     rate: 0.10 },
    { base: 19682,   basicTax: 615,     rate: 0.12 },
    { base: 26031,   basicTax: 1377,    rate: 0.15 },
    { base: 34255,   basicTax: 2611,    rate: 0.20 },
    { base: 45407,   basicTax: 4841,    rate: 0.25 },
    { base: 60450,   basicTax: 8602,    rate: 0.30 },
    { base: 80605,   basicTax: 14648,   rate: 0.35 },
    { base: 107199,  basicTax: 23956,   rate: 0.37 },
  ],
};
export const LATEST_INCOME_TAX_YEAR = 2024;

export function incomeTaxBrackets(year?: number): IncomeTaxBracket[] {
  const y = year && INCOME_TAX_BRACKETS_BY_YEAR[year] ? year : LATEST_INCOME_TAX_YEAR;
  return INCOME_TAX_BRACKETS_BY_YEAR[y];
}
