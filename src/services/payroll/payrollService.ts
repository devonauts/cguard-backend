/**
 * Payroll service — turns a guard's real month (shifts, hours, configured
 * salary) into a full Ecuadorian rol de pagos using the pure, tested engine
 * (ecuadorPayroll.ts). Tenant-scoped; reads salaries/rates from nominaSettings.
 *
 * Two entry points:
 *  · preview(input)          — manual calculator (explicit numbers, no DB).
 *  · previewGuardMonth(...)  — data-driven: aggregates the guard's shifts for a
 *                              month, resolves the salary from nominaSettings,
 *                              and computes the statutory rol de pagos.
 *
 * The engine is country-pure; this layer is where the platform's data + the
 * tenant's nominaSettings overrides meet it. No salary is invented — when a
 * guard has no configured monthly salary we fall back to the SBU and flag the
 * source so the CRM can warn the operator.
 */
import { Op } from 'sequelize';
import { IServiceOptions } from '../IServiceOptions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import { getNominaSettings } from '../../lib/nominaSettings';
import {
  computeEcuadorPayroll,
  EcuadorPayrollInput,
  EcuadorPayrollResult,
} from './ecuadorPayroll';
import { EcuadorStatutory, sbuForYear } from '../../lib/ecuadorPayrollConstants';

export interface GuardMonthAggregate {
  guardId: string;
  guardName: string;
  year: number;
  month: number; // 1-12
  shiftCount: number;
  regularHours: number;
  /** Overtime hours (from overtimeMinutes) — mapped to horas suplementarias. */
  overtimeHours: number;
  lateMinutes: number;
}

export interface GuardPayrollPreview {
  aggregate: GuardMonthAggregate;
  /** Where the monthly salary came from — so the UI can flag fallbacks. */
  salarySource: 'guard-override' | 'tenant-default' | 'sbu-fallback';
  monthlyRemuneration: number;
  yearsOfService: number;
  payroll: EcuadorPayrollResult;
}

function monthRangeUtc(year: number, month: number): { from: Date; to: Date } {
  // month is 1-12. Range is [first day 00:00, next month 00:00) in UTC.
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { from, to };
}

export default class PayrollService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  private get db() {
    return this.options.database;
  }

  private get tenantId(): string {
    return SequelizeRepository.getCurrentTenant(this.options).id;
  }

  /** Manual calculator — run the pure engine on explicit inputs. */
  preview(
    input: EcuadorPayrollInput,
    year?: number,
    overrides: Partial<EcuadorStatutory> = {},
  ): EcuadorPayrollResult {
    return computeEcuadorPayroll(input, year, overrides);
  }

  /** Sum a guard's worked shifts for a calendar month (tenant-scoped). */
  async aggregateGuardMonth(
    guardId: string,
    year: number,
    month: number,
  ): Promise<GuardMonthAggregate> {
    const { from, to } = monthRangeUtc(year, month);
    const rows = (
      await this.db.guardShift.findAll({
        where: {
          tenantId: this.tenantId,
          guardNameId: guardId,
          punchInTime: { [Op.gte]: from, [Op.lt]: to },
        },
        attributes: ['id', 'hoursWorked', 'overtimeMinutes', 'lateMinutes', 'punchInTime'],
        include: [{ model: this.db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'] }],
        order: [['punchInTime', 'ASC']],
      })
    ).map((r: any) => r.get({ plain: true }));

    let regularMinutes = 0;
    let overtimeMinutes = 0;
    let lateMinutes = 0;
    let guardName = '';
    for (const r of rows) {
      const worked = Number(r.hoursWorked) || 0; // includes overtime
      const ot = Number(r.overtimeMinutes) || 0;
      overtimeMinutes += ot;
      // Regular = worked hours minus the overtime portion (never negative).
      regularMinutes += Math.max(0, worked * 60 - ot);
      lateMinutes += Number(r.lateMinutes) || 0;
      if (!guardName && r.guardName?.fullName) guardName = r.guardName.fullName;
    }

    return {
      guardId,
      guardName,
      year,
      month,
      shiftCount: rows.length,
      regularHours: Math.round((regularMinutes / 60) * 100) / 100,
      overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
      lateMinutes,
    };
  }

  /**
   * Full data-driven rol de pagos for one guard/month. Resolves the monthly
   * salary from nominaSettings (per-guard override → tenant default → SBU), the
   * years of service from the guard's hiring date, and maps overtime hours to
   * horas suplementarias before running the statutory engine.
   */
  async previewGuardMonth(
    guardId: string,
    opts: {
      year: number;
      month: number;
      /** Explicit override for the monthly salary (skips nominaSettings lookup). */
      monthlyRemuneration?: number;
      decimoTerceroMensualizado?: boolean;
      decimoCuartoMensualizado?: boolean;
      fondosReservaMensualizado?: boolean;
      otherEarnings?: number;
      otherDeductions?: number;
      projectedAnnualIncomeTax?: number;
    },
  ): Promise<GuardPayrollPreview> {
    const { year, month } = opts;
    const aggregate = await this.aggregateGuardMonth(guardId, year, month);

    const settings = await getNominaSettings(this.db, this.tenantId);
    const pr = settings.payroll;

    // Resolve the monthly salary + its provenance.
    let monthlyRemuneration: number;
    let salarySource: GuardPayrollPreview['salarySource'];
    if (opts.monthlyRemuneration != null && opts.monthlyRemuneration > 0) {
      monthlyRemuneration = opts.monthlyRemuneration;
      salarySource = 'guard-override';
    } else if (pr.guardMonthlySalaries && pr.guardMonthlySalaries[guardId] > 0) {
      monthlyRemuneration = pr.guardMonthlySalaries[guardId];
      salarySource = 'guard-override';
    } else if (pr.defaultMonthlySalary > 0) {
      monthlyRemuneration = pr.defaultMonthlySalary;
      salarySource = 'tenant-default';
    } else {
      monthlyRemuneration = sbuForYear(year);
      salarySource = 'sbu-fallback';
    }

    // Years of service from the guard's hiring date (fondos de reserva gate).
    const guard = await this.db.securityGuard.findOne({
      where: { id: guardId, tenantId: this.tenantId },
      attributes: ['id', 'hiringContractDate'],
    });
    const yearsOfService = guard?.hiringContractDate
      ? Math.max(0, Math.floor((Date.now() - new Date(guard.hiringContractDate).getTime()) / (365.25 * 24 * 3600 * 1000)))
      : 0;

    // Tenant overrides for the hour-multipliers / night surcharge.
    const overrides: Partial<EcuadorStatutory> = {};
    if (typeof pr.nightSurchargePct === 'number' && pr.nightSurchargePct > 0) {
      // nominaSettings stores it as a fraction already (Ecuador default 0.25).
      overrides.nightSurchargePct = pr.nightSurchargePct;
    }

    const input: EcuadorPayrollInput = {
      monthlyRemuneration,
      // Guard's hourly rate override, if configured; else engine defaults to /240.
      hourlyRate: pr.guardRates && pr.guardRates[guardId] > 0 ? pr.guardRates[guardId] : undefined,
      workedHours: {
        regular: aggregate.regularHours,
        // Overtime hours map to horas suplementarias (1.5×). Extraordinarias /
        // nocturno need the finer per-hour classification we don't yet capture.
        supplementary: aggregate.overtimeHours,
      },
      yearsOfService,
      decimoTerceroMensualizado: opts.decimoTerceroMensualizado,
      decimoCuartoMensualizado: opts.decimoCuartoMensualizado,
      fondosReservaMensualizado: opts.fondosReservaMensualizado,
      otherEarnings: opts.otherEarnings,
      otherDeductions: opts.otherDeductions,
      projectedAnnualIncomeTax: opts.projectedAnnualIncomeTax,
    };

    const payroll = computeEcuadorPayroll(input, year, overrides);

    return { aggregate, salarySource, monthlyRemuneration, yearsOfService, payroll };
  }
}
