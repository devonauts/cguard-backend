import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import { getTenantTz, tenantDayRange } from '../../lib/tenantTz';

/**
 * Client "Reportes" analytics — all real, client-scoped over a period:
 * headline KPIs (with vs-previous-period delta + daily sparkline), cumplimiento
 * de puestos, incidentes por tipo/estado, actividades por día, the client's real
 * operational reports (report rows) and its scheduled reports (reportSchedule).
 */

const localYmd = (d: Date, tz: string) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return new Date(d).toISOString().slice(0, 10); }
};
const parseDate = (s: any, fb: Date) => { const d = s ? new Date(String(s)) : null; return d && !Number.isNaN(d.getTime()) ? d : fb; };
const delta = (cur: number, prev: number) => { if (!prev) return cur > 0 ? 100 : 0; return Math.round(((cur - prev) / prev) * 100); };
const normStatus = (status?: string | null, work?: string | null): 'abierto' | 'investigacion' | 'resuelto' => {
  const w = (work || '').toLowerCase();
  if (w === 'resolved' || w === 'closed' || (status || '').toLowerCase() === 'cerrado') return 'resuelto';
  if (w === 'inprogress' || w === 'investigating' || w === 'investigacion') return 'investigacion';
  return 'abierto';
};

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();

    const tz = await getTenantTz(db, tenantId);
    // Day boundaries in the tenant's timezone (server runs UTC) so the daily buckets
    // and the range endpoints agree and the last day's evening rows aren't dropped.
    const { from, to } = tenantDayRange(req.query.from, req.query.to, tz, { defaultSpanDays: 30 });
    const spanMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - spanMs);

    // Client sedes + stations.
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
    const siteIds = sedeRows.map((s: any) => String(s.id));
    const sedeName = new Map<string, string>(sedeRows.map((s: any) => [String(s.id), s.companyName || 'Sede']));
    const stationRows = await db.station.findAll({
      where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['id', 'stationName', 'postSiteId', 'scheduleType'],
    });
    const stationIds = stationRows.map((s: any) => String(s.id));
    const stationName = new Map<string, string>(stationRows.map((s: any) => [String(s.id), s.stationName]));

    const linkOr: any[] = [{ clientId: clientAccountId }];
    if (stationIds.length) linkOr.push({ stationId: stationIds });
    if (siteIds.length) linkOr.push({ postSiteId: siteIds });

    const emptyDaily = () => { const m = new Map<string, number>(); for (let t = from.getTime(); t <= to.getTime(); t += 86400000) m.set(localYmd(new Date(t), tz), 0); return m; };
    const seriesArr = (m: Map<string, number>) => [...m.entries()].map(([date, value]) => ({ date, value }));

    // ── Incidents (both periods) ─────────────────────────────────────────────
    const incRows = await db.incident.findAll({
      where: { [Op.and]: [{ [Op.or]: [{ tenantId }, { tenantId: null }] }, { [Op.or]: linkOr }, { createdAt: { [Op.between]: [prevFrom, to] } }] },
      include: [{ model: db.incidentType, as: 'incidentType', attributes: ['id', 'name'], required: false }],
      attributes: ['id', 'createdAt', 'status', 'workStatus', 'dispatchedAt', 'incidentTypeId'],
      limit: 20000,
    }).catch(() => []);
    const incDaily = emptyDaily();
    let incCur = 0, incPrev = 0;
    const byType = new Map<string, number>();
    const byState = { abierto: 0, investigacion: 0, resuelto: 0 };
    const respMins: number[] = [];
    for (const r of incRows) {
      const t = new Date(r.createdAt);
      const inCur = t >= from && t <= to;
      if (inCur) { incCur++; const k = localYmd(t, tz); if (incDaily.has(k)) incDaily.set(k, incDaily.get(k)! + 1);
        byType.set(r.incidentType?.name || 'Otros', (byType.get(r.incidentType?.name || 'Otros') || 0) + 1);
        byState[normStatus(r.status, r.workStatus)]++;
        if (r.dispatchedAt) respMins.push(Math.max(0, (+new Date(r.dispatchedAt) - +t) / 60000));
      } else if (t >= prevFrom && t < from) incPrev++;
    }
    const incTotal = incCur;
    const incidentesPorTipo = [...byType.entries()].map(([type, count]) => ({ type, count, pct: incTotal ? Math.round((count / incTotal) * 100) : 0 })).sort((a, b) => b.count - a.count);
    const stTotal = byState.abierto + byState.investigacion + byState.resuelto;
    const incidentesPorEstado = [
      { key: 'resuelto', label: 'Resueltos', count: byState.resuelto, pct: stTotal ? Math.round((byState.resuelto / stTotal) * 100) : 0 },
      { key: 'investigacion', label: 'En investigación', count: byState.investigacion, pct: stTotal ? Math.round((byState.investigacion / stTotal) * 100) : 0 },
      { key: 'abierto', label: 'Abiertos', count: byState.abierto, pct: stTotal ? Math.round((byState.abierto / stTotal) * 100) : 0 },
    ];
    const respCur = respMins.length ? Math.round(respMins.reduce((a, b) => a + b, 0) / respMins.length) : null;

    // ── Tag scans (rondas + checkpoints, both periods) ───────────────────────
    const scanDaily = emptyDaily();
    let scanCur = 0, scanPrev = 0; const rondaSetCur = new Set<string>(), rondaSetPrev = new Set<string>();
    try {
      if (stationIds.length) {
        const scans = await db.tagScan.findAll({ where: { tenantId, stationId: stationIds, scannedAt: { [Op.between]: [prevFrom, to] } }, attributes: ['securityGuardId', 'stationId', 'scannedAt'], limit: 40000 });
        for (const s of scans) {
          const t = new Date(s.scannedAt); const day = localYmd(t, tz);
          const sess = `${s.securityGuardId}|${s.stationId}|${day}`;
          if (t >= from && t <= to) { scanCur++; if (scanDaily.has(day)) scanDaily.set(day, scanDaily.get(day)! + 1); rondaSetCur.add(sess); }
          else if (t >= prevFrom && t < from) { scanPrev++; rondaSetPrev.add(sess); }
        }
      }
    } catch { /* optional */ }
    const rondasCur = rondaSetCur.size, rondasPrev = rondaSetPrev.size;

    // ── Attendance (guardShift clock-ins, both periods) ──────────────────────
    const attDaily = emptyDaily();
    let attCur = 0, attPrev = 0;
    try {
      const orGs: any[] = [];
      if (stationIds.length) orGs.push({ stationNameId: stationIds });
      if (siteIds.length) orGs.push({ postSiteId: siteIds });
      if (orGs.length) {
        const gs = await db.guardShift.findAll({ where: { [Op.and]: [{ tenantId }, { [Op.or]: orGs }, { punchInTime: { [Op.between]: [prevFrom, to] } }] }, attributes: ['punchInTime'], limit: 40000 });
        for (const r of gs) { const t = new Date(r.punchInTime); const day = localYmd(t, tz);
          if (t >= from && t <= to) { attCur++; if (attDaily.has(day)) attDaily.set(day, attDaily.get(day)! + 1); }
          else if (t >= prevFrom && t < from) attPrev++;
        }
      }
    } catch { /* optional */ }

    // ── Cumplimiento de puestos OVER THE PERIOD (scheduled shifts vs attended) ──
    // A reports page covers a whole period, so this is a period attendance ratio —
    // NOT a single-instant snapshot (which read a scary 0%/100% when nobody happened
    // to be clocked in at that exact moment). Neutral "sin datos" when no schedule.
    let scheduledCount = 0;
    try {
      if (stationIds.length) scheduledCount = await db.shift.count({ where: { tenantId, stationId: stationIds, startTime: { [Op.between]: [from, to] } } });
    } catch { /* optional */ }
    let cumplimiento: any;
    if (scheduledCount > 0) {
      const cumplidos = Math.min(attCur, scheduledCount);
      const incumplidos = Math.max(0, scheduledCount - cumplidos);
      const pct = Math.round((cumplidos / scheduledCount) * 100);
      cumplimiento = { pct, cumplidos, parciales: 0, incumplidos, cumplidosPct: pct, parcialesPct: 0, incumplidosPct: 100 - pct, total: scheduledCount, hasData: true };
    } else if (attCur > 0) {
      // Attendance exists but no generated schedule to compare against → treat as covered.
      cumplimiento = { pct: 100, cumplidos: attCur, parciales: 0, incumplidos: 0, cumplidosPct: 100, parcialesPct: 0, incumplidosPct: 0, total: attCur, hasData: true };
    } else {
      cumplimiento = { pct: null, cumplidos: 0, parciales: 0, incumplidos: 0, cumplidosPct: 0, parcialesPct: 0, incumplidosPct: 0, total: 0, hasData: false };
    }

    // ── Actividades por día (incidents + scans + clock-ins) ──────────────────
    const actDaily = emptyDaily();
    for (const [k, v] of incDaily) actDaily.set(k, (actDaily.get(k) || 0) + v);
    for (const [k, v] of scanDaily) actDaily.set(k, (actDaily.get(k) || 0) + v);
    for (const [k, v] of attDaily) actDaily.set(k, (actDaily.get(k) || 0) + v);

    const kpis = [
      { key: 'incidentes', label: 'Incidentes reportados', value: incCur, deltaPct: delta(incCur, incPrev), invert: true, spark: seriesArr(incDaily).map((d) => d.value), tone: 'red' },
      { key: 'rondas', label: 'Rondas completadas', value: rondasCur, deltaPct: delta(rondasCur, rondasPrev), spark: seriesArr(scanDaily).map((d) => d.value), tone: 'green' },
      { key: 'asistencias', label: 'Asistencias registradas', value: attCur, deltaPct: delta(attCur, attPrev), spark: seriesArr(attDaily).map((d) => d.value), tone: 'blue' },
      { key: 'checkpoints', label: 'Checkpoints escaneados', value: scanCur, deltaPct: delta(scanCur, scanPrev), spark: seriesArr(scanDaily).map((d) => d.value), tone: 'violet' },
      { key: 'respuesta', label: 'Tiempo promedio de respuesta', value: respCur, unit: 'min', deltaPct: 0, invert: true, spark: seriesArr(incDaily).map((d) => d.value), tone: 'blue', isTime: true },
    ];

    // ── Operational reports list (real report rows at client stations) ───────
    let reportsList: any[] = [];
    let reportsTotal = 0;
    try {
      if (stationIds.length) {
        const q = String(req.query.q || '').trim().toLowerCase();
        const all = await db.report.findAll({
          where: { tenantId, stationId: stationIds },
          include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName', 'postSiteId'], required: false }, { model: db.user, as: 'createdBy', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
          order: [['generatedDate', 'DESC']],
          limit: 2000,
        });
        let mapped = all.map((r: any, i: number) => {
          const sedeId = r.station?.postSiteId ? String(r.station.postSiteId) : null;
          return {
            id: String(r.id),
            code: `RPT-${String(all.length - i).padStart(5, '0')}`,
            name: r.title || 'Reporte',
            sede: (sedeId && sedeName.get(sedeId)) || r.station?.stationName || '—',
            puesto: r.station?.stationName || null,
            generadoPor: r.createdBy ? (r.createdBy.fullName || [r.createdBy.firstName, r.createdBy.lastName].filter(Boolean).join(' ')) : 'Sistema',
            fecha: r.generatedDate ? new Date(r.generatedDate).toISOString() : (r.createdAt ? new Date(r.createdAt).toISOString() : null),
            tipo: 'Operativo', formato: 'PDF',
          };
        });
        if (q) mapped = mapped.filter((m: any) => m.name.toLowerCase().includes(q) || m.sede.toLowerCase().includes(q) || m.code.toLowerCase().includes(q));
        reportsTotal = mapped.length;
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const perPage = Math.min(50, Math.max(5, parseInt(String(req.query.perPage || '10'), 10) || 10));
        reportsList = mapped.slice((page - 1) * perPage, page * perPage);
      }
    } catch { /* optional */ }

    // ── Scheduled reports for this client ────────────────────────────────────
    let programados: any[] = [];
    try {
      const scheds = await db.reportSchedule.findAll({ where: { tenantId }, order: [['createdAt', 'DESC']], limit: 100 }).catch(() => []);
      programados = (scheds || [])
        .filter((s: any) => { const p = s.params || {}; return String(p.clientId || '') === String(clientAccountId); })
        .map((s: any) => ({ id: String(s.id), name: s.name, cron: s.cron, active: !!s.active, frequency: (s.params || {}).frequencyLabel || (s.params || {}).frequency || null, nextRunAt: s.nextRunAt, params: s.params }));
    } catch { /* optional */ }

    const quickReports = [
      { key: 'incidents', label: 'Reporte de incidentes' },
      { key: 'rounds', label: 'Reporte de rondas' },
      { key: 'visitors', label: 'Reporte de visitas' },
      { key: 'attendance', label: 'Reporte de asistencia' },
      { key: 'coverage', label: 'Cumplimiento de puestos' },
      { key: 'guard-activity', label: 'Actividad por guardia' },
    ];

    return ApiResponseHandler.success(req, res, {
      period: { from: from.toISOString(), to: to.toISOString() },
      tz,
      kpis,
      cumplimiento,
      incidentesPorTipo, incidentesTotal: incTotal,
      incidentesPorEstado,
      actividadesPorDia: seriesArr(actDaily),
      quickReports,
      programados,
      reportsList, reportsTotal,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
