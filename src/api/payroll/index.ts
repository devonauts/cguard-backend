/**
 * Payroll (rol de pagos) API — tenant-scoped, permission-gated (attendanceRead
 * to view, attendanceEdit for anything that would persist). Wraps the pure,
 * unit-tested Ecuadorian payroll engine behind three read surfaces:
 *
 *   POST /tenant/:tenantId/payroll/preview            manual calculator
 *   GET  /tenant/:tenantId/payroll/guard/:guardId     data-driven guard/month
 *   GET  /tenant/:tenantId/payroll/statutory          the statutory constants
 *
 * Nothing here writes to the DB yet — a rol de pagos is computed on demand.
 * Persisting closed periods is the next increment (needs a payrollRun table).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PayrollService from '../../services/payroll/payrollService';
import {
  ecuadorStatutory,
  incomeTaxBrackets,
  sbuForYear,
} from '../../lib/ecuadorPayrollConstants';

const P = Permissions.values;

export default (app) => {
  const base = '/tenant/:tenantId/payroll';

  // Manual calculator — explicit inputs, no DB. Body = EcuadorPayrollInput plus
  // optional { year, overrides }.
  app.post(`${base}/preview`, async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(P.attendanceRead);
      const body = req.body?.data || req.body || {};
      const { year, overrides, ...input } = body;
      const payroll = new PayrollService(req).preview(input, year, overrides || {});
      await ApiResponseHandler.success(req, res, payroll);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Statutory constants for a year (SBU, IESS %, IR brackets). Lets the CRM show
  // the figures the calculation used and stay in sync with the backend.
  app.get(`${base}/statutory`, async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(P.attendanceRead);
      const year = req.query.year ? parseInt(String(req.query.year), 10) : undefined;
      await ApiResponseHandler.success(req, res, {
        year: year || null,
        sbu: sbuForYear(year),
        statutory: ecuadorStatutory(year),
        incomeTaxBrackets: incomeTaxBrackets(year),
      });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Whole-tenant rol de pagos for a month — one row per active guard + totals.
  // This is what the CRM Rol de pagos page renders + exports for the accountant.
  app.get(`${base}/roster`, async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(P.attendanceRead);
      const now = new Date();
      const year = req.query.year ? parseInt(String(req.query.year), 10) : now.getUTCFullYear();
      const month = req.query.month ? parseInt(String(req.query.month), 10) : now.getUTCMonth() + 1;
      if (!(month >= 1 && month <= 12)) {
        return await ApiResponseHandler.error(req, res, Object.assign(new Error('month must be 1-12'), { code: 400 }));
      }
      const bool = (v: any) => v === true || v === 'true' || v === '1';
      const roster = await new PayrollService(req).previewRoster({
        year,
        month,
        decimoTerceroMensualizado: bool(req.query.decimoTerceroMensualizado),
        decimoCuartoMensualizado: bool(req.query.decimoCuartoMensualizado),
        fondosReservaMensualizado: bool(req.query.fondosReservaMensualizado),
      });
      await ApiResponseHandler.success(req, res, roster);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Data-driven rol de pagos for one guard + month. Query: year, month (1-12),
  // and optional mensualizado flags / other earnings / deductions.
  app.get(`${base}/guard/:guardId`, async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(P.attendanceRead);
      const now = new Date();
      const year = req.query.year ? parseInt(String(req.query.year), 10) : now.getUTCFullYear();
      const month = req.query.month ? parseInt(String(req.query.month), 10) : now.getUTCMonth() + 1;
      if (!(month >= 1 && month <= 12)) {
        return await ApiResponseHandler.error(req, res, Object.assign(new Error('month must be 1-12'), { code: 400 }));
      }
      const num = (v: any) => (v != null && v !== '' ? Number(v) : undefined);
      const bool = (v: any) => v === true || v === 'true' || v === '1';
      const preview = await new PayrollService(req).previewGuardMonth(req.params.guardId, {
        year,
        month,
        monthlyRemuneration: num(req.query.monthlyRemuneration),
        decimoTerceroMensualizado: bool(req.query.decimoTerceroMensualizado),
        decimoCuartoMensualizado: bool(req.query.decimoCuartoMensualizado),
        fondosReservaMensualizado: bool(req.query.fondosReservaMensualizado),
        otherEarnings: num(req.query.otherEarnings),
        otherDeductions: num(req.query.otherDeductions),
        projectedAnnualIncomeTax: num(req.query.projectedAnnualIncomeTax),
      });
      await ApiResponseHandler.success(req, res, preview);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
