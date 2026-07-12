/**
 * Unit tests — Ecuadorian payroll engine (pure calc).
 *
 * Verifies the statutory math against known figures: IESS 9.45%/11.15%,
 * fondos de reserva 8.33% (after 1yr), décimo tercero (imponible/12), décimo
 * cuarto (SBU/12), vacaciones (imponible/24), horas suplementarias 1.5× /
 * extraordinarias 2× / recargo nocturno 25%, and the progressive IR table.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/payroll/ecuadorPayroll.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import { computeEcuadorPayroll, annualIncomeTax } from '../../../src/services/payroll/ecuadorPayroll';
import { sbuForYear } from '../../../src/lib/ecuadorPayrollConstants';

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

describe('ecuadorPayroll', () => {
  describe('base case — SBU earner, no extras, first year (no fondos)', () => {
    const r = computeEcuadorPayroll({ monthlyRemuneration: 470, yearsOfService: 0 }, 2025);

    it('imponible equals the base salary when no extras', () => {
      assert.strictEqual(r.earnings.imponible, 470);
    });
    it('aporte personal IESS = 9.45% of imponible', () => {
      assert.ok(near(r.deductions.iessPersonal, 470 * 0.0945), `got ${r.deductions.iessPersonal}`);
      assert.ok(near(r.deductions.iessPersonal, 44.42));
    });
    it('aporte patronal IESS = 11.15% (employer cost, not deducted)', () => {
      assert.ok(near(r.employerCost.iessPatronal, 470 * 0.1115));
      assert.ok(near(r.employerCost.iessPatronal, 52.41));
    });
    it('NO fondos de reserva in the first year', () => {
      assert.strictEqual(r.earnings.fondosReserva, 0);
      assert.strictEqual(r.employerCost.fondosReservaProvision, 0);
    });
    it('net pay = salary − aporte personal', () => {
      assert.ok(near(r.netPay, 470 - 44.42), `net ${r.netPay}`);
    });
    it('décimos default to employer PROVISIONS, not monthly earnings', () => {
      assert.strictEqual(r.earnings.decimoTercero, 0);
      assert.strictEqual(r.earnings.decimoCuarto, 0);
      assert.ok(near(r.employerCost.decimoTerceroProvision, 470 / 12));
      assert.ok(near(r.employerCost.decimoCuartoProvision, sbuForYear(2025) / 12));
    });
    it('vacaciones provision ≈ imponible / 24', () => {
      assert.ok(near(r.employerCost.vacacionesProvision, 470 / 24), `got ${r.employerCost.vacacionesProvision}`);
    });
  });

  describe('after 1 year — fondos de reserva mensualizado', () => {
    const r = computeEcuadorPayroll(
      { monthlyRemuneration: 600, yearsOfService: 2, fondosReservaMensualizado: true },
      2025,
    );
    it('fondos de reserva = 8.33% of imponible, paid this month', () => {
      assert.ok(near(r.earnings.fondosReserva, 600 * 0.0833), `got ${r.earnings.fondosReserva}`);
      assert.strictEqual(r.employerCost.fondosReservaProvision, 0);
    });
    it('fondos are NOT part of the IESS imponible', () => {
      assert.strictEqual(r.earnings.imponible, 600);
      assert.ok(near(r.deductions.iessPersonal, 600 * 0.0945));
    });
    it('totalEarnings includes the mensualizado fondos', () => {
      assert.ok(near(r.earnings.totalEarnings, 600 + 600 * 0.0833));
    });
  });

  describe('extra hours — suplementarias 1.5×, extraordinarias 2×, nocturno 25%', () => {
    // hourlyRate forced to 5 for clean math.
    const r = computeEcuadorPayroll({
      monthlyRemuneration: 1200,
      hourlyRate: 5,
      workedHours: { supplementary: 10, extraordinary: 4, night: 20 },
      yearsOfService: 3,
    }, 2025);

    it('horas suplementarias = 10h × $5 × 1.5', () => {
      assert.ok(near(r.earnings.supplementaryPay, 10 * 5 * 1.5), `got ${r.earnings.supplementaryPay}`); // 75
    });
    it('horas extraordinarias = 4h × $5 × 2', () => {
      assert.ok(near(r.earnings.extraordinaryPay, 4 * 5 * 2)); // 40
    });
    it('recargo nocturno = 20h × $5 × 0.25', () => {
      assert.ok(near(r.earnings.nightSurcharge, 20 * 5 * 0.25)); // 25
    });
    it('imponible includes the surcharge pay', () => {
      assert.ok(near(r.earnings.imponible, 1200 + 75 + 40 + 25)); // 1340
    });
    it('aporte personal computed on the fuller imponible', () => {
      assert.ok(near(r.deductions.iessPersonal, 1340 * 0.0945));
    });
  });

  describe('mensualizado décimos add to the paycheck', () => {
    const r = computeEcuadorPayroll({
      monthlyRemuneration: 470,
      yearsOfService: 0,
      decimoTerceroMensualizado: true,
      decimoCuartoMensualizado: true,
    }, 2025);
    it('décimo tercero mensual = imponible / 12', () => {
      assert.ok(near(r.earnings.decimoTercero, 470 / 12));
      assert.strictEqual(r.employerCost.decimoTerceroProvision, 0);
    });
    it('décimo cuarto mensual = SBU / 12', () => {
      assert.ok(near(r.earnings.decimoCuarto, 470 / 12));
    });
    it('net pay includes both mensualized décimos', () => {
      const expected = 470 + 470 / 12 + 470 / 12 - 470 * 0.0945;
      assert.ok(near(r.netPay, expected), `net ${r.netPay} vs ${expected}`);
    });
  });

  describe('other earnings & deductions', () => {
    const r = computeEcuadorPayroll({
      monthlyRemuneration: 800,
      otherEarnings: 100,   // comisión (imponible)
      otherDeductions: 50,  // anticipo
      yearsOfService: 0,
    }, 2025);
    it('other earnings raise the imponible', () => {
      assert.strictEqual(r.earnings.imponible, 900);
      assert.ok(near(r.deductions.iessPersonal, 900 * 0.0945));
    });
    it('other deductions reduce net pay', () => {
      assert.ok(near(r.netPay, 900 - 900 * 0.0945 - 50), `net ${r.netPay}`);
    });
  });

  describe('income tax (IR) progressive table', () => {
    it('below the fracción básica desgravada → 0', () => {
      assert.strictEqual(annualIncomeTax(10000, 2024), 0);
    });
    it('mid-bracket uses basicTax + (income − base) × rate', () => {
      // 2024: base 19682 → basicTax 615, rate 0.12
      const income = 22000;
      const expected = 615 + (income - 19682) * 0.12;
      assert.ok(near(annualIncomeTax(income, 2024), expected), `got ${annualIncomeTax(income, 2024)}`);
    });
    it('monthly withholding = projected annual / 12', () => {
      const r = computeEcuadorPayroll({ monthlyRemuneration: 3000, projectedAnnualIncomeTax: 1200 }, 2025);
      assert.strictEqual(r.deductions.incomeTax, 100);
    });
  });

  describe('guards against bad input', () => {
    it('negative salary clamps to 0', () => {
      const r = computeEcuadorPayroll({ monthlyRemuneration: -500 }, 2025);
      assert.strictEqual(r.earnings.baseSalary, 0);
      assert.strictEqual(r.netPay, 0);
    });
    it('missing worked hours → no surcharges', () => {
      const r = computeEcuadorPayroll({ monthlyRemuneration: 500 }, 2025);
      assert.strictEqual(r.earnings.supplementaryPay, 0);
      assert.strictEqual(r.earnings.nightSurcharge, 0);
    });
  });
});
