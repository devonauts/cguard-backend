import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

const csvCell = (v: any) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: any[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
const parseDate = (s: any, fb: Date) => { const d = s ? new Date(String(s)) : null; return d && !Number.isNaN(d.getTime()) ? d : fb; };

async function clientStations(db: any, Op: any, tenantId: string, clientAccountId: string) {
  const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
  const siteIds = sedeRows.map((s: any) => String(s.id));
  const stationRows = await db.station.findAll({
    where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
    attributes: ['id', 'stationName'],
  });
  return { siteIds, stationRows, stationIds: stationRows.map((s: any) => String(s.id)), stationName: new Map<string, string>(stationRows.map((s: any) => [String(s.id), s.stationName])) };
}

/** GET a real CSV export for the client + period (Reportes rápidos). */
export const exportCsv = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();
    const to = parseDate(req.query.to, now); to.setHours(23, 59, 59, 999);
    const from = parseDate(req.query.from, new Date(to.getTime() - 30 * 24 * 3600 * 1000)); from.setHours(0, 0, 0, 0);
    const type = String(req.query.type || 'incidents');

    const { siteIds, stationIds, stationName } = await clientStations(db, Op, tenantId, clientAccountId);
    let out: any[][] = [];
    let fname = `reporte-${type}`;

    if (type === 'incidents') {
      const linkOr: any[] = [{ clientId: clientAccountId }];
      if (stationIds.length) linkOr.push({ stationId: stationIds });
      if (siteIds.length) linkOr.push({ postSiteId: siteIds });
      const rows = await db.incident.findAll({
        where: { [Op.and]: [{ [Op.or]: [{ tenantId }, { tenantId: null }] }, { [Op.or]: linkOr }, { createdAt: { [Op.between]: [from, to] } }] },
        include: [{ model: db.incidentType, as: 'incidentType', attributes: ['name'], required: false }, { model: db.securityGuard, as: 'guardName', attributes: ['fullName'], required: false }],
        order: [['createdAt', 'DESC']], limit: 10000,
      }).catch(() => []);
      out = [['Fecha', 'Titulo', 'Tipo', 'Prioridad', 'Estado', 'Puesto', 'Reportado por', 'Descripcion']];
      for (const r of rows) out.push([r.createdAt ? new Date(r.createdAt).toISOString() : '', r.title || '', r.incidentType?.name || '', r.priority || '', r.workStatus || r.status || '', r.stationId ? (stationName.get(String(r.stationId)) || '') : '', r.guardName?.fullName || '', (r.description || '').replace(/\s+/g, ' ')]);
    } else if (type === 'rounds') {
      const scans = stationIds.length ? await db.tagScan.findAll({ where: { tenantId, stationId: stationIds, scannedAt: { [Op.between]: [from, to] } }, include: [{ model: db.securityGuard, as: 'guard', attributes: ['fullName'], required: false }], order: [['scannedAt', 'DESC']], limit: 20000 }).catch(() => []) : [];
      out = [['Fecha', 'Puesto', 'Guardia', 'Checkpoint']];
      for (const s of scans) out.push([s.scannedAt ? new Date(s.scannedAt).toISOString() : '', s.stationId ? (stationName.get(String(s.stationId)) || '') : '', s.guard?.fullName || '', s.tagIdentifier || s.name || '']);
    } else if (type === 'attendance') {
      const orGs: any[] = [];
      if (stationIds.length) orGs.push({ stationNameId: stationIds });
      if (siteIds.length) orGs.push({ postSiteId: siteIds });
      const gs = orGs.length ? await db.guardShift.findAll({ where: { [Op.and]: [{ tenantId }, { [Op.or]: orGs }, { punchInTime: { [Op.between]: [from, to] } }] }, include: [{ model: db.securityGuard, as: 'guardName', attributes: ['fullName'], required: false }], order: [['punchInTime', 'DESC']], limit: 20000 }).catch(() => []) : [];
      out = [['Guardia', 'Puesto', 'Entrada', 'Salida', 'Horas']];
      for (const r of gs) out.push([r.guardName?.fullName || '', r.stationNameId ? (stationName.get(String(r.stationNameId)) || '') : '', r.punchInTime ? new Date(r.punchInTime).toISOString() : '', r.punchOutTime ? new Date(r.punchOutTime).toISOString() : '', r.hoursWorked != null ? String(r.hoursWorked) : '']);
    } else if (type === 'guard-activity') {
      const orGs: any[] = [];
      if (stationIds.length) orGs.push({ stationNameId: stationIds });
      const gs = orGs.length ? await db.guardShift.findAll({ where: { [Op.and]: [{ tenantId }, { [Op.or]: orGs }, { punchInTime: { [Op.between]: [from, to] } }] }, include: [{ model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: false }], attributes: ['guardNameId', 'hoursWorked'], limit: 40000 }).catch(() => []) : [];
      const agg = new Map<string, { name: string; shifts: number; hours: number }>();
      for (const r of gs) { const k = String(r.guardNameId); const cur = agg.get(k) || { name: r.guardName?.fullName || '—', shifts: 0, hours: 0 }; cur.shifts++; cur.hours += Number(r.hoursWorked) || 0; agg.set(k, cur); }
      out = [['Guardia', 'Turnos', 'Horas']];
      for (const v of agg.values()) out.push([v.name, v.shifts, Math.round(v.hours * 10) / 10]);
    } else if (type === 'coverage') {
      const positions = stationIds.length ? await db.stationPosition.findAll({ where: { tenantId, stationId: stationIds, type: 'fijo' }, attributes: ['stationId', 'guardsNeeded'] }).catch(() => []) : [];
      const need = new Map<string, number>();
      for (const p of positions) need.set(String(p.stationId), (need.get(String(p.stationId)) || 0) + (Number(p.guardsNeeded) || 1));
      const open = stationIds.length ? await db.guardShift.findAll({ where: { tenantId, stationNameId: stationIds, punchOutTime: null }, attributes: ['stationNameId'] }).catch(() => []) : [];
      const on = new Map<string, number>();
      for (const o of open) on.set(String(o.stationNameId), (on.get(String(o.stationNameId)) || 0) + 1);
      out = [['Puesto', 'Requeridos', 'En turno', 'Estado']];
      for (const id of stationIds) { const nd = need.get(id) || 0; const o = on.get(id) || 0; out.push([stationName.get(id) || '', nd, o, o >= nd && nd > 0 ? 'Cubierto' : o > 0 ? 'Parcial' : nd > 0 ? 'Sin cobertura' : 'Sin turno']); }
    } else {
      return ApiResponseHandler.error(req, res, { code: 400, message: 'tipo inválido' });
    }

    const body = csv(out);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send('﻿' + body);
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
    const freq = FREQ[String(raw.frequency || 'weekly')] || FREQ.weekly;
    const rec = await db.reportSchedule.create({
      name: raw.name || 'Reporte programado',
      cron: freq.cron,
      active: true,
      params: { clientId: req.params.id, type: raw.type || 'incidents', frequency: raw.frequency || 'weekly', frequencyLabel: freq.label },
      tenantId,
      createdById: req.currentUser?.id || null,
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
