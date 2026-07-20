import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import { generateClientReport } from '../../services/clientReportGenerator';
import { computeScheduleNextRun } from '../../services/scheduledReportService';
import { getTenantTz, tenantDayRange } from '../../lib/tenantTz';

/** GET a real CSV export for the client + period (Reportes rápidos). */
export const exportCsv = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    // Day boundaries in the tenant's timezone (server runs UTC) so the last day's
    // evening activity isn't dropped and early next-day rows don't leak in.
    const tz = await getTenantTz(db, tenantId);
    const { from, to } = tenantDayRange(req.query.from, req.query.to, tz, { defaultSpanDays: 30 });
    const type = String(req.query.type || 'incidents');

    const result = await generateClientReport(db, { tenantId, clientAccountId, type, from, to });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send('﻿' + result.csv);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST create a scheduled report for this client. */
export const createSchedule = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.reportCreate);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const raw = req.body?.data || req.body || {};
    const FREQ: Record<string, { cron: string; label: string }> = {
      daily: { cron: '0 7 * * *', label: 'Todos los días a las 07:00' },
      weekly: { cron: '0 8 * * 1', label: 'Todos los lunes a las 08:00' },
      monthly: { cron: '0 9 1 * *', label: 'Primer día de cada mes a las 09:00' },
    };
    const frequency = String(raw.frequency || 'weekly');
    const freq = FREQ[frequency] || FREQ.weekly;
    const rec = await db.reportSchedule.create({
      name: raw.name || 'Reporte programado',
      cron: freq.cron,
      active: true,
      params: { clientId: req.params.id, type: raw.type || 'incidents', frequency, frequencyLabel: freq.label },
      tenantId,
      createdById: req.currentUser?.id || null,
      // Without this the runner would treat it as due immediately; set the first
      // real fire time so it runs on schedule.
      nextRunAt: computeScheduleNextRun(frequency),
    });
    return ApiResponseHandler.success(req, res, { id: rec.id, name: rec.name, active: rec.active, frequency: raw.frequency, frequencyLabel: freq.label });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** DELETE a scheduled report. */
export const deleteSchedule = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.reportCreate);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const row: any = await db.reportSchedule.findByPk(req.params.scheduleId);
    if (!row || row.tenantId !== tenantId || String((row.params || {}).clientId || '') !== String(req.params.id)) return ApiResponseHandler.error(req, res, { code: 404 });
    await row.destroy();
    return ApiResponseHandler.success(req, res, { id: req.params.scheduleId, deleted: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
