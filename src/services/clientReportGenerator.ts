/**
 * Builds a client activity report (CSV) for a given client + period + type.
 * Shared by the on-demand export handler (clientAccountReportActions.exportCsv)
 * and the scheduled-reports runner (scheduledReportService), so both produce the
 * exact same report from a single implementation.
 */

const csvCell = (v: any) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: any[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

async function clientStations(db: any, Op: any, tenantId: string, clientAccountId: string) {
  const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
  const siteIds = sedeRows.map((s: any) => String(s.id));
  const stationRows = await db.station.findAll({
    where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
    attributes: ['id', 'stationName'],
  });
  return {
    siteIds,
    stationIds: stationRows.map((s: any) => String(s.id)),
    stationName: new Map<string, string>(stationRows.map((s: any) => [String(s.id), s.stationName])),
  };
}

export interface ClientReportInput {
  tenantId: string;
  clientAccountId: string;
  type: string; // incidents | rounds | attendance | guard-activity | coverage
  from: Date;
  to: Date;
}

export interface ClientReportResult {
  filename: string;
  csv: string;
  headerRow: string[];
  rowCount: number; // data rows, excluding the header
}

/** Returns the report matrix (header + data rows) and a ready-to-send CSV string. */
export async function generateClientReport(db: any, input: ClientReportInput): Promise<ClientReportResult> {
  const Op = db.Sequelize.Op;
  const { tenantId, clientAccountId, type, from, to } = input;
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
  } else if (type === 'visitors') {
    const linkOr: any[] = [{ clientId: clientAccountId }];
    if (stationIds.length) linkOr.push({ stationId: stationIds });
    if (siteIds.length) linkOr.push({ postSiteId: siteIds });
    const rows = await db.visitorLog.findAll({
      where: { [Op.and]: [{ tenantId }, { [Op.or]: linkOr }, { visitDate: { [Op.between]: [from, to] } }] },
      order: [['visitDate', 'DESC']], limit: 20000,
    }).catch(() => []);
    out = [['Fecha entrada', 'Nombre', 'Apellidos', 'Identificación', 'Motivo', 'Salida', 'Personas', 'Puesto']];
    for (const r of rows) out.push([
      r.visitDate ? new Date(r.visitDate).toISOString() : '', r.firstName || '', r.lastName || '',
      r.idNumber || '', r.reason || '', r.exitTime ? new Date(r.exitTime).toISOString() : '',
      r.numPeople != null ? String(r.numPeople) : '', r.stationId ? (stationName.get(String(r.stationId)) || '') : '',
    ]);
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
    throw new Error('tipo inválido');
  }

  const filename = `${fname}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv`;
  return { filename, csv: toCsv(out), headerRow: out[0] as string[], rowCount: Math.max(0, out.length - 1) };
}

export default generateClientReport;
