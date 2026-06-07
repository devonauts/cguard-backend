/**
 * Operations analytics for the CRM "Analíticas" dashboard.
 * GET /api/tenant/:tenantId/operations/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Returns tenant-scoped KPIs + breakdowns for the date range: shift coverage,
 * ronda completion, checkpoint location compliance, attendance/punctuality,
 * incidents, a per-day trend, and per-site / per-guard performance.
 *
 * Every query is defensive (returns 0/[] on failure) so one bad table never
 * breaks the whole dashboard. Strictly scoped to the authenticated tenant.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const tenantId = req.currentTenant && req.currentTenant.id;
    if (!tenantId) {
      return ApiResponseHandler.success(req, res, { error: 'no-tenant' });
    }
    const db = req.database;
    const sq = db.sequelize;
    const QT = sq.QueryTypes.SELECT;

    // ── date range ──────────────────────────────────────────────────────────
    const now = new Date();
    const end = req.query.endDate ? new Date(String(req.query.endDate)) : new Date(now);
    if (req.query.endDate) end.setHours(23, 59, 59, 999);
    const start = req.query.startDate
      ? new Date(String(req.query.startDate))
      : new Date(now.getTime() - 29 * 86400000);
    start.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));

    const R = { tenantId, start, end };
    const q = async (sql: string, replacements: any = R): Promise<any[]> => {
      try { return (await sq.query(sql, { replacements, type: QT })) as any[]; }
      catch (e: any) { console.warn('[analytics] query failed:', e?.message || e); return []; }
    };
    const one = async (sql: string, repl: any = R) => (await q(sql, repl))[0] || {};
    const num = (v: any) => Number(v || 0);

    // ── KPIs ────────────────────────────────────────────────────────────────
    const onDuty = await one(
      `SELECT COUNT(DISTINCT guardNameId) n FROM guardShifts
       WHERE tenantId=:tenantId AND deletedAt IS NULL AND punchOutTime IS NULL`,
      { tenantId },
    );
    const shifts = await one(
      `SELECT COUNT(*) total, SUM(CASE WHEN guardId IS NOT NULL THEN 1 ELSE 0 END) covered
       FROM shifts WHERE tenantId=:tenantId AND deletedAt IS NULL
       AND startTime >= :start AND startTime <= :end`,
    );
    const rondas = await one(
      `SELECT COUNT(*) total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed
       FROM tourAssignments WHERE tenantId=:tenantId AND deletedAt IS NULL
       AND createdAt >= :start AND createdAt <= :end`,
    );
    const scans = await one(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN validLocation=1 THEN 1 ELSE 0 END) valid,
              SUM(CASE WHEN validLocation IS NOT NULL THEN 1 ELSE 0 END) verified
       FROM tagScans WHERE tenantId=:tenantId AND deletedAt IS NULL
       AND scannedAt >= :start AND scannedAt <= :end`,
    );
    const incidents = await one(
      `SELECT COUNT(*) total, SUM(CASE WHEN status='abierto' THEN 1 ELSE 0 END) open
       FROM incidents WHERE tenantId=:tenantId AND deletedAt IS NULL
       AND createdAt >= :start AND createdAt <= :end`,
    );
    const att = await one(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='on_time' THEN 1 ELSE 0 END) onTime,
              SUM(CASE WHEN status='late' OR lateMinutes>0 THEN 1 ELSE 0 END) late,
              SUM(CASE WHEN earlyDepartureMinutes>0 THEN 1 ELSE 0 END) early,
              SUM(CASE WHEN punchInOutsideGeofence=1 OR punchOutOutsideGeofence=1 THEN 1 ELSE 0 END) geoViol,
              COALESCE(SUM(hoursWorked),0) hours
       FROM guardShifts WHERE tenantId=:tenantId AND deletedAt IS NULL
       AND punchInTime >= :start AND punchInTime <= :end`,
    );

    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
    const kpis = {
      guardsOnDuty: num(onDuty.n),
      shiftsTotal: num(shifts.total), shiftsCovered: num(shifts.covered),
      coveragePct: pct(num(shifts.covered), num(shifts.total)),
      rondasTotal: num(rondas.total), rondasCompleted: num(rondas.completed),
      rondaCompletionPct: pct(num(rondas.completed), num(rondas.total)),
      scansTotal: num(scans.total), scansValid: num(scans.valid),
      locationCompliancePct: pct(num(scans.valid), num(scans.verified)),
      incidentsTotal: num(incidents.total), incidentsOpen: num(incidents.open),
      clockinsTotal: num(att.total), clockinsOnTime: num(att.onTime),
      punctualityPct: pct(num(att.onTime), num(att.total)),
    };
    const attendance = {
      hoursWorked: Math.round(num(att.hours)),
      late: num(att.late), earlyDeparture: num(att.early), geofenceViolations: num(att.geoViol),
    };

    // ── per-day trend ─────────────────────────────────────────────────────────
    const trendIncidents = await q(`SELECT DATE(createdAt) d, COUNT(*) c FROM incidents WHERE tenantId=:tenantId AND deletedAt IS NULL AND createdAt>=:start AND createdAt<=:end GROUP BY DATE(createdAt)`);
    const trendScans = await q(`SELECT DATE(scannedAt) d, COUNT(*) c FROM tagScans WHERE tenantId=:tenantId AND deletedAt IS NULL AND scannedAt>=:start AND scannedAt<=:end GROUP BY DATE(scannedAt)`);
    const trendRondas = await q(`SELECT DATE(COALESCE(endAt, createdAt)) d, COUNT(*) c FROM tourAssignments WHERE tenantId=:tenantId AND deletedAt IS NULL AND status='completed' AND COALESCE(endAt, createdAt)>=:start AND COALESCE(endAt, createdAt)<=:end GROUP BY DATE(COALESCE(endAt, createdAt))`);
    const dayKey = (v: any) => {
      const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const mapBy = (rows: any[]) => { const m: Record<string, number> = {}; rows.forEach((r) => { m[dayKey(r.d)] = num(r.c); }); return m; };
    const incMap = mapBy(trendIncidents), scanMap = mapBy(trendScans), rondaMap = mapBy(trendRondas);
    const trend: any[] = [];
    const nDays = Math.min(days, 92); // cap series length
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      trend.push({ date: k, incidents: incMap[k] || 0, scans: scanMap[k] || 0, rondas: rondaMap[k] || 0 });
    }

    // ── incidents breakdown ────────────────────────────────────────────────────
    const byPriority = (await q(`SELECT COALESCE(NULLIF(priority,''),'sin prioridad') label, COUNT(*) c FROM incidents WHERE tenantId=:tenantId AND deletedAt IS NULL AND createdAt>=:start AND createdAt<=:end GROUP BY label ORDER BY c DESC`))
      .map((r) => ({ label: String(r.label), count: num(r.c) }));
    const topIncidentSites = (await q(`
      SELECT COALESCE(b.companyName, s.stationName, 'Sin asignar') site, COUNT(*) c
      FROM incidents i
      LEFT JOIN businessInfos b ON i.postSiteId = b.id
      LEFT JOIN stations s ON i.stationId = s.id
      WHERE i.tenantId=:tenantId AND i.deletedAt IS NULL AND i.createdAt>=:start AND i.createdAt<=:end
      GROUP BY site ORDER BY c DESC LIMIT 8`))
      .map((r) => ({ site: String(r.site), count: num(r.c) }));

    // ── per-site performance ────────────────────────────────────────────────────
    const sites = await q(`SELECT id, companyName FROM businessInfos WHERE tenantId=:tenantId AND deletedAt IS NULL`, { tenantId });
    const sShifts = await q(`SELECT postSiteId pid, COUNT(*) total, SUM(CASE WHEN guardId IS NOT NULL THEN 1 ELSE 0 END) covered FROM shifts WHERE tenantId=:tenantId AND deletedAt IS NULL AND startTime>=:start AND startTime<=:end GROUP BY postSiteId`);
    const sRondas = await q(`SELECT postSiteId pid, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM tourAssignments WHERE tenantId=:tenantId AND deletedAt IS NULL AND createdAt>=:start AND createdAt<=:end GROUP BY postSiteId`);
    const sInc = await q(`SELECT postSiteId pid, COUNT(*) c FROM incidents WHERE tenantId=:tenantId AND deletedAt IS NULL AND createdAt>=:start AND createdAt<=:end GROUP BY postSiteId`);
    const sGuards = await q(`SELECT postSiteId pid, COUNT(DISTINCT guardNameId) g FROM guardShifts WHERE tenantId=:tenantId AND deletedAt IS NULL AND punchInTime>=:start AND punchInTime<=:end GROUP BY postSiteId`);
    const sLoc = await q(`SELECT st.postSiteId pid, SUM(CASE WHEN ts.validLocation=1 THEN 1 ELSE 0 END) valid, SUM(CASE WHEN ts.validLocation IS NOT NULL THEN 1 ELSE 0 END) verified FROM tagScans ts JOIN stations st ON ts.stationId=st.id WHERE ts.tenantId=:tenantId AND ts.deletedAt IS NULL AND ts.scannedAt>=:start AND ts.scannedAt<=:end GROUP BY st.postSiteId`);
    const idx = (rows: any[]) => { const m: Record<string, any> = {}; rows.forEach((r) => { if (r.pid) m[String(r.pid)] = r; }); return m; };
    const shM = idx(sShifts), roM = idx(sRondas), inM = idx(sInc), guM = idx(sGuards), loM = idx(sLoc);
    const perSite = sites.map((s: any) => {
      const id = String(s.id);
      const sh = shM[id] || {}, lo = loM[id] || {};
      return {
        site: s.companyName || 'Sitio',
        guards: num((guM[id] || {}).g),
        shiftsTotal: num(sh.total), shiftsCovered: num(sh.covered),
        coveragePct: pct(num(sh.covered), num(sh.total)),
        rondasCompleted: num((roM[id] || {}).completed),
        incidents: num((inM[id] || {}).c),
        locationCompliancePct: pct(num(lo.valid), num(lo.verified)),
      };
    }).filter((r: any) => r.shiftsTotal || r.guards || r.rondasCompleted || r.incidents)
      .sort((a: any, b: any) => b.incidents - a.incidents || b.shiftsTotal - a.shiftsTotal);

    // ── per-guard performance ───────────────────────────────────────────────────
    const perGuard = (await q(`
      SELECT sg.id, sg.fullName name,
             COUNT(gs.id) shifts,
             COALESCE(SUM(gs.hoursWorked),0) hours,
             SUM(CASE WHEN gs.status='on_time' THEN 1 ELSE 0 END) onTime,
             SUM(CASE WHEN gs.status='late' OR gs.lateMinutes>0 THEN 1 ELSE 0 END) late,
             COALESCE(SUM(gs.incidentsLogged),0) incidents
      FROM guardShifts gs
      JOIN securityGuards sg ON gs.guardNameId = sg.id
      WHERE gs.tenantId=:tenantId AND gs.deletedAt IS NULL AND gs.punchInTime>=:start AND gs.punchInTime<=:end
      GROUP BY sg.id, sg.fullName
      ORDER BY hours DESC LIMIT 50`))
      .map((r) => ({
        name: r.name || '—',
        shifts: num(r.shifts),
        hoursWorked: Math.round(num(r.hours)),
        onTimePct: pct(num(r.onTime), num(r.shifts)),
        late: num(r.late),
        incidents: num(r.incidents),
      }));

    return ApiResponseHandler.success(req, res, {
      range: { start: start.toISOString(), end: end.toISOString(), days },
      kpis,
      attendance,
      trend,
      incidentsByPriority: byPriority,
      topIncidentSites,
      perSite,
      perGuard,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
