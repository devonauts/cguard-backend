/**
 * Unit tests — PayrollService orchestration.
 *
 * The pure engine is covered by ecuadorPayroll.test.ts. This suite covers the
 * DB/settings layer on top: month-shift aggregation (regular vs overtime split),
 * monthly-salary resolution + provenance (guard override → tenant default → SBU
 * fallback) and the years-of-service gate feeding fondos de reserva.
 *
 * Fake db + stubbed getNominaSettings; no MySQL, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/payroll/payrollService.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import sinon from 'sinon';

import PayrollService from '../../../src/services/payroll/payrollService';
import * as nominaSettingsModule from '../../../src/lib/nominaSettings';

const TENANT = 'tenant-xyz';
const GUARD = 'guard-1';

// A guardShift row as Sequelize returns it (with .get({plain})).
const shift = (hoursWorked: number, overtimeMinutes = 0, lateMinutes = 0) => ({
  get: () => ({ id: Math.random().toString(36).slice(2), hoursWorked, overtimeMinutes, lateMinutes, guardName: { id: GUARD, fullName: 'Juan Pérez' } }),
});

function makeService(opts: {
  shifts?: any[];
  hiringContractDate?: Date | null;
  payrollSettings?: any;
}) {
  const db: any = {
    guardShift: { findAll: async () => opts.shifts || [] },
    securityGuard: { findOne: async () => (opts.hiringContractDate !== undefined ? { id: GUARD, hiringContractDate: opts.hiringContractDate } : null) },
  };
  const settings = {
    payroll: {
      guardMonthlySalaries: {},
      defaultMonthlySalary: 0,
      guardRates: {},
      nightSurchargePct: 0.25,
      ...(opts.payrollSettings || {}),
    },
  };
  sinon.stub(nominaSettingsModule, 'getNominaSettings').resolves(settings as any);
  return new PayrollService({ database: db, currentTenant: { id: TENANT } } as any);
}

describe('PayrollService', () => {
  afterEach(() => sinon.restore());

  describe('aggregateGuardMonth', () => {
    it('splits worked hours into regular vs overtime (overtimeMinutes carved out)', async () => {
      // 3 shifts: 8h with 0 OT, 10h with 120min (2h) OT, 8h with 0 OT.
      const svc = makeService({ shifts: [shift(8), shift(10, 120), shift(8)] });
      const agg = await svc.aggregateGuardMonth(GUARD, 2025, 6);
      assert.strictEqual(agg.shiftCount, 3);
      assert.strictEqual(agg.overtimeHours, 2);       // 120 min
      assert.strictEqual(agg.regularHours, 24);       // (8+10+8) - 2 OT = 24
      assert.strictEqual(agg.guardName, 'Juan Pérez');
    });

    it('never returns negative regular hours when OT exceeds worked', async () => {
      const svc = makeService({ shifts: [shift(1, 120)] }); // 1h worked, 2h "OT"
      const agg = await svc.aggregateGuardMonth(GUARD, 2025, 6);
      assert.ok(agg.regularHours >= 0, `regular ${agg.regularHours}`);
    });
  });

  describe('salary resolution + provenance', () => {
    it('uses the per-guard monthly override when configured', async () => {
      const svc = makeService({
        shifts: [shift(8)],
        payrollSettings: { guardMonthlySalaries: { [GUARD]: 900 } },
      });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6 });
      assert.strictEqual(p.salarySource, 'guard-override');
      assert.strictEqual(p.monthlyRemuneration, 900);
    });

    it('falls back to the tenant default salary', async () => {
      const svc = makeService({ shifts: [shift(8)], payrollSettings: { defaultMonthlySalary: 550 } });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6 });
      assert.strictEqual(p.salarySource, 'tenant-default');
      assert.strictEqual(p.monthlyRemuneration, 550);
    });

    it('falls back to the SBU when nothing is configured (and flags it)', async () => {
      const svc = makeService({ shifts: [shift(8)] });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6 });
      assert.strictEqual(p.salarySource, 'sbu-fallback');
      assert.strictEqual(p.monthlyRemuneration, 470); // SBU 2025
    });

    it('an explicit monthlyRemuneration override wins over settings', async () => {
      const svc = makeService({ shifts: [shift(8)], payrollSettings: { defaultMonthlySalary: 550 } });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6, monthlyRemuneration: 1200 });
      assert.strictEqual(p.monthlyRemuneration, 1200);
      assert.strictEqual(p.salarySource, 'guard-override');
    });
  });

  describe('years of service gates fondos de reserva', () => {
    it('no fondos when hired under a year ago', async () => {
      const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const svc = makeService({ shifts: [shift(8)], hiringContractDate: recent, payrollSettings: { defaultMonthlySalary: 600 } });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6, fondosReservaMensualizado: true });
      assert.strictEqual(p.yearsOfService, 0);
      assert.strictEqual(p.payroll.earnings.fondosReserva, 0);
    });

    it('fondos accrue after a full year of service', async () => {
      const twoYears = new Date(Date.now() - 2 * 365.25 * 24 * 3600 * 1000);
      const svc = makeService({ shifts: [shift(8)], hiringContractDate: twoYears, payrollSettings: { defaultMonthlySalary: 600 } });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6, fondosReservaMensualizado: true });
      assert.ok(p.yearsOfService >= 1, `years ${p.yearsOfService}`);
      assert.ok(p.payroll.earnings.fondosReserva > 0, `fondos ${p.payroll.earnings.fondosReserva}`);
    });
  });

  describe('overtime hours reach the engine as horas suplementarias', () => {
    it('overtime raises supplementary pay + imponible', async () => {
      const svc = makeService({
        shifts: [shift(10, 120)], // 2h OT
        payrollSettings: { defaultMonthlySalary: 720, guardRates: { [GUARD]: 5 } },
      });
      const p = await svc.previewGuardMonth(GUARD, { year: 2025, month: 6 });
      // 2h × $5 × 1.5 = $15 supplementary.
      assert.ok(Math.abs(p.payroll.earnings.supplementaryPay - 15) < 0.01, `sup ${p.payroll.earnings.supplementaryPay}`);
      assert.ok(p.payroll.earnings.imponible > 720, `imponible ${p.payroll.earnings.imponible}`);
    });
  });
});
