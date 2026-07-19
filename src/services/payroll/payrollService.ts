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
  /** Distinct calendar days with at least one punch-in. */
  daysWorked: number;
  regularHours: number;
  /** Overtime hours (from overtimeMinutes) — mapped to horas suplementarias. */
  overtimeHours: number;
  lateMinutes: number;
  /** Which worker table this aggregate came from. */
  role: 'guard' | 'supervisor' | 'administrative';
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

/** Best available display name for a user row, with a role-appropriate fallback. */
function userDisplayName(u: any, fallback: string): string {
  return String(
    u?.fullName ||
      [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
      u?.email ||
      fallback,
  );
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
    const days = new Set<string>();
    for (const r of rows) {
      const worked = Number(r.hoursWorked) || 0; // includes overtime
      const ot = Number(r.overtimeMinutes) || 0;
      overtimeMinutes += ot;
      // Regular = worked hours minus the overtime portion (never negative).
      regularMinutes += Math.max(0, worked * 60 - ot);
      lateMinutes += Number(r.lateMinutes) || 0;
      if (r.punchInTime) days.add(new Date(r.punchInTime).toISOString().slice(0, 10));
      if (!guardName && r.guardName?.fullName) guardName = r.guardName.fullName;
    }

    return {
      guardId,
      guardName,
      year,
      month,
      shiftCount: rows.length,
      daysWorked: days.size,
      regularHours: Math.round((regularMinutes / 60) * 100) / 100,
      overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
      lateMinutes,
      role: 'guard',
    };
  }

  /**
   * Sum a supervisor's or office-staff member's worked shifts for a month.
   * Supervisors live in supervisorShift (keyed supervisorUserId), office staff in
   * staffShift (keyed userId). Neither table tracks overtime, so overtimeHours=0.
   */
  private async aggregateWorkerMonth(
    model: any,
    userKey: 'supervisorUserId' | 'userId',
    userId: string,
    fullName: string,
    role: 'supervisor' | 'administrative',
    year: number,
    month: number,
  ): Promise<GuardMonthAggregate> {
    const { from, to } = monthRangeUtc(year, month);
    const rows = (
      await model.findAll({
        where: {
          tenantId: this.tenantId,
          [userKey]: userId,
          punchInTime: { [Op.gte]: from, [Op.lt]: to },
        },
        attributes: ['id', 'hoursWorked', 'lateMinutes', 'punchInTime'],
        order: [['punchInTime', 'ASC']],
      })
    ).map((r: any) => r.get({ plain: true }));

    let regularMinutes = 0;
    let lateMinutes = 0;
    const days = new Set<string>();
    for (const r of rows) {
      regularMinutes += Math.max(0, (Number(r.hoursWorked) || 0) * 60);
      lateMinutes += Number(r.lateMinutes) || 0;
      if (r.punchInTime) days.add(new Date(r.punchInTime).toISOString().slice(0, 10));
    }

    return {
      guardId: (role === 'supervisor' ? 'sup:' : 'stf:') + userId,
      guardName: fullName,
      year,
      month,
      shiftCount: rows.length,
      daysWorked: days.size,
      regularHours: Math.round((regularMinutes / 60) * 100) / 100,
      overtimeHours: 0,
      lateMinutes,
      role,
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
    /** Preloaded context so a roster run doesn't refetch settings/guard per row. */
    ctx?: { settings?: any; hiringContractDate?: Date | string | null },
  ): Promise<GuardPayrollPreview> {
    const { year, month } = opts;
    const aggregate = await this.aggregateGuardMonth(guardId, year, month);

    // Years of service from the guard's hiring date (fondos de reserva gate).
    let hiringContractDate: Date | string | null | undefined = ctx ? ctx.hiringContractDate : undefined;
    if (!ctx) {
      const guard = await this.db.securityGuard.findOne({
        where: { id: guardId, tenantId: this.tenantId },
        attributes: ['id', 'hiringContractDate'],
      });
      hiringContractDate = guard?.hiringContractDate;
    }

    const settings = ctx?.settings ?? (await getNominaSettings(this.db, this.tenantId));
    return this.runPayrollForAggregate(aggregate, guardId, hiringContractDate, opts, settings);
  }

  /**
   * Run the statutory engine for a pre-computed aggregate. Resolves the monthly
   * salary (per-worker override → tenant default → SBU) keyed by `salaryKey`
   * (guardId, or 'sup:'/'stf:'-prefixed userId), then computes the rol de pagos.
   * Shared by guards, supervisors and office staff.
   */
  private runPayrollForAggregate(
    aggregate: GuardMonthAggregate,
    salaryKey: string,
    hiringContractDate: Date | string | null | undefined,
    opts: {
      year: number;
      monthlyRemuneration?: number;
      decimoTerceroMensualizado?: boolean;
      decimoCuartoMensualizado?: boolean;
      fondosReservaMensualizado?: boolean;
      otherEarnings?: number;
      otherDeductions?: number;
      projectedAnnualIncomeTax?: number;
    },
    settings: any,
  ): GuardPayrollPreview {
    const { year } = opts;
    const pr = settings.payroll;

    // Resolve the monthly salary + its provenance.
    let monthlyRemuneration: number;
    let salarySource: GuardPayrollPreview['salarySource'];
    if (opts.monthlyRemuneration != null && opts.monthlyRemuneration > 0) {
      monthlyRemuneration = opts.monthlyRemuneration;
      salarySource = 'guard-override';
    } else if (pr.guardMonthlySalaries && pr.guardMonthlySalaries[salaryKey] > 0) {
      monthlyRemuneration = pr.guardMonthlySalaries[salaryKey];
      salarySource = 'guard-override';
    } else if (pr.defaultMonthlySalary > 0) {
      monthlyRemuneration = pr.defaultMonthlySalary;
      salarySource = 'tenant-default';
    } else {
      monthlyRemuneration = sbuForYear(year);
      salarySource = 'sbu-fallback';
    }

    const yearsOfService = hiringContractDate
      ? Math.max(0, Math.floor((Date.now() - new Date(hiringContractDate).getTime()) / (365.25 * 24 * 3600 * 1000)))
      : 0;

    // Tenant overrides for the hour-multipliers / night surcharge.
    const overrides: Partial<EcuadorStatutory> = {};
    if (typeof pr.nightSurchargePct === 'number' && pr.nightSurchargePct > 0) {
      // nominaSettings stores it as a fraction already (Ecuador default 0.25).
      overrides.nightSurchargePct = pr.nightSurchargePct;
    }

    const input: EcuadorPayrollInput = {
      monthlyRemuneration,
      // Worker's hourly rate override, if configured; else engine defaults to /240.
      hourlyRate: pr.guardRates && pr.guardRates[salaryKey] > 0 ? pr.guardRates[salaryKey] : undefined,
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

  /**
   * The whole tenant's rol de pagos for a month — one row per worker (guards +
   * supervisors + office staff), plus tenant totals. This is what the CRM
   * exports (Excel/PDF) for the accountant to run the transfers/checks. Settings
   * + rosters are loaded ONCE; the per-worker shift aggregation is the only
   * per-row query. Supervisors/staff carry no hiring date, so fondos de reserva
   * only applies once they have a configured monthly salary and ≥1 year — their
   * years-of-service defaults to 0 here.
   */
  async previewRoster(opts: {
    year: number;
    month: number;
    decimoTerceroMensualizado?: boolean;
    decimoCuartoMensualizado?: boolean;
    fondosReservaMensualizado?: boolean;
  }): Promise<any> {
    const settings = await getNominaSettings(this.db, this.tenantId);
    const guards = (
      await this.db.securityGuard.findAll({
        where: { tenantId: this.tenantId, deletedAt: null },
        attributes: ['id', 'fullName', 'hiringContractDate'],
        order: [['fullName', 'ASC']],
      })
    ).map((g: any) => g.get({ plain: true }));

    const rows: any[] = [];
    for (const g of guards) {
      const p = await this.previewGuardMonth(g.id, opts, {
        settings,
        hiringContractDate: g.hiringContractDate,
      });
      rows.push({ guardId: g.id, guardName: g.fullName, role: 'guard', ...p });
    }

    // Fold supervisors (supervisorShift) — resolve their names from the user
    // table for anyone who punched this month.
    try {
      const { from, to } = monthRangeUtc(opts.year, opts.month);
      const supShifts = await this.db.supervisorShift.findAll({
        where: { tenantId: this.tenantId, punchInTime: { [Op.gte]: from, [Op.lt]: to } },
        attributes: ['supervisorUserId'],
        group: ['supervisorUserId'],
      });
      const supIds: string[] = [...new Set(supShifts.map((s: any) => String(s.supervisorUserId)).filter(Boolean) as string[])];
      if (supIds.length) {
        const users = await this.db.user.findAll({
          where: { id: { [Op.in]: supIds } },
          attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
        });
        const nameById = new Map<string, string>(
          users.map((u: any): [string, string] => [String(u.id), userDisplayName(u, 'Supervisor')]),
        );
        for (const uid of supIds) {
          const aggregate = await this.aggregateWorkerMonth(
            this.db.supervisorShift, 'supervisorUserId', uid,
            nameById.get(uid) || 'Supervisor', 'supervisor', opts.year, opts.month,
          );
          const p = this.runPayrollForAggregate(aggregate, aggregate.guardId, null, opts, settings);
          rows.push({ guardId: aggregate.guardId, guardName: aggregate.guardName, role: 'supervisor', ...p });
        }
      }
    } catch { /* supervisors optional */ }

    // Fold office/administrative staff (staffShift).
    try {
      if (this.db.staffShift) {
        const { from, to } = monthRangeUtc(opts.year, opts.month);
        const staffShifts = await this.db.staffShift.findAll({
          where: { tenantId: this.tenantId, punchInTime: { [Op.gte]: from, [Op.lt]: to } },
          attributes: ['userId'],
          group: ['userId'],
        });
        const staffIds: string[] = [...new Set(staffShifts.map((s: any) => String(s.userId)).filter(Boolean) as string[])];
        if (staffIds.length) {
          const users = await this.db.user.findAll({
            where: { id: { [Op.in]: staffIds } },
            attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
          });
          const nameById = new Map<string, string>(
            users.map((u: any): [string, string] => [String(u.id), userDisplayName(u, 'Administrativo')]),
          );
          for (const uid of staffIds) {
            const aggregate = await this.aggregateWorkerMonth(
              this.db.staffShift, 'userId', uid,
              nameById.get(uid) || 'Administrativo', 'administrative', opts.year, opts.month,
            );
            const p = this.runPayrollForAggregate(aggregate, aggregate.guardId, null, opts, settings);
            rows.push({ guardId: aggregate.guardId, guardName: aggregate.guardName, role: 'administrative', ...p });
          }
        }
      }
    } catch { /* staff optional */ }

    // Guards first (alpha), then supervisors, then administrative — each alpha.
    const roleOrder: Record<string, number> = { guard: 0, supervisor: 1, administrative: 2 };
    rows.sort((a, b) => (roleOrder[a.role] - roleOrder[b.role]) || String(a.guardName).localeCompare(String(b.guardName)));

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const totals = rows.reduce(
      (t, r) => {
        t.imponible += r.payroll.earnings.imponible;
        t.totalEarnings += r.payroll.earnings.totalEarnings;
        t.iessPersonal += r.payroll.deductions.iessPersonal;
        t.totalDeductions += r.payroll.deductions.totalDeductions;
        t.iessPatronal += r.payroll.employerCost.iessPatronal;
        t.employerCost += r.payroll.employerCost.totalCost;
        t.netPay += r.payroll.netPay;
        return t;
      },
      { imponible: 0, totalEarnings: 0, iessPersonal: 0, totalDeductions: 0, iessPatronal: 0, employerCost: 0, netPay: 0 },
    );
    Object.keys(totals).forEach((k) => (totals[k] = round2(totals[k])));

    return { year: opts.year, month: opts.month, currency: 'USD', count: rows.length, rows, totals };
  }
}
