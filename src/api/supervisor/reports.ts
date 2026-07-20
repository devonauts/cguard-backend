import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Reports/analytics overview for the supervisor Reports screen. Aggregates real
 * data over a date range (default: last 7 days) with the previous equal period
 * for the % deltas: hours worked + daily series (guardShift.hoursWorked), late
 * arrivals (lateMinutes), incidents, checkpoint completion (patrolLog.status →
 * tagScan.validLocation fallback), and top-5 guard performance (guardRating →
 * punctuality fallback). Everything is best-effort — missing data yields zeros,
 * never a 500. Gated `supervisorMe`.
 *
 * GET /tenant/:tenantId/supervisor/me/reports?from=&to=
 */
const LATE_THRESHOLD_MIN = 5;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(0, 0, 0, 0);
  while (d <= end) { out.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return out.slice(0, 60);
}
function pct(cur: number, prev: number): number {
  if (!prev) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}
function num(v: any): number { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : 0; }

export const getReports = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;

    const to = req.query.to ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 6 * 86400000);
    from.setHours(0, 0, 0, 0);
    const span = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(from.getTime() - span - 1);
    const days = eachDay(from, to);

    // ---- shifts: hours + late arrivals (current + previous) ----
    const shiftAttrs = ['hoursWorked', 'lateMinutes', 'punchInTime', 'guardNameId'];
    const [shifts, prevShifts] = await Promise.all([
      db.guardShift.findAll({ where: { tenantId, punchInTime: { [Op.between]: [from, to] } }, attributes: shiftAttrs }).catch(() => []),
      db.guardShift.findAll({ where: { tenantId, punchInTime: { [Op.between]: [prevFrom, prevTo] } }, attributes: ['hoursWorked', 'lateMinutes'] }).catch(() => []),
    ]);
    const totalHours = shifts.reduce((s: number, r: any) => s + num(r.hoursWorked), 0);
    const prevHours = prevShifts.reduce((s: number, r: any) => s + num(r.hoursWorked), 0);
    const lateArrivals = shifts.filter((r: any) => num(r.lateMinutes) > LATE_THRESHOLD_MIN).length;
    const prevLate = prevShifts.filter((r: any) => num(r.lateMinutes) > LATE_THRESHOLD_MIN).length;

    const hoursByDay = new Map<string, number>();
    const lateByDay = new Map<string, number>();
    for (const r of shifts) {
      if (!r.punchInTime) continue;
      const k = dayKey(new Date(r.punchInTime));
      hoursByDay.set(k, (hoursByDay.get(k) || 0) + num(r.hoursWorked));
      if (num(r.lateMinutes) > LATE_THRESHOLD_MIN) lateByDay.set(k, (lateByDay.get(k) || 0) + 1);
    }

    // ---- incidents ----
    const [incRows, prevInc] = await Promise.all([
      db.incident.findAll({ where: { tenantId, date: { [Op.between]: [from, to] } }, attributes: ['date'] }).catch(() => []),
      db.incident.count({ where: { tenantId, date: { [Op.between]: [prevFrom, prevTo] } } }).catch(() => 0),
    ]);
    const incByDay = new Map<string, number>();
    for (const r of incRows) { const k = dayKey(new Date(r.date)); incByDay.set(k, (incByDay.get(k) || 0) + 1); }
    const incidents = incRows.length;

    // ---- checkpoints: patrolLog.status → tagScan.validLocation fallback ----
    let completed = 0, missed = 0, incomplete = 0;
    try {
      const logs = await db.patrolLog.findAll({ where: { tenantId, scanTime: { [Op.between]: [from, to] } }, attributes: ['status', 'validLocation'] });
      if (logs.length) {
        for (const l of logs) {
          const st = String(l.status || '').toLowerCase();
          if (st.includes('miss')) missed++;
          else if (st.includes('incomplete') || st.includes('skip') || l.validLocation === false) incomplete++;
          else completed++;
        }
      } else {
        const scans = await db.tagScan.findAll({ where: { tenantId, scannedAt: { [Op.between]: [from, to] } }, attributes: ['validLocation'] });
        for (const s of scans) { if (s.validLocation === false) incomplete++; else completed++; }
      }
    } catch { /* checkpoints best-effort */ }
    const cpTotal = completed + missed + incomplete;
    const cpCompletion = cpTotal ? Math.round((completed / cpTotal) * 1000) / 10 : 0;

    // Previous-period completion for the delta.
    let prevCompletion = 0;
    try {
      const pl = await db.patrolLog.findAll({ where: { tenantId, scanTime: { [Op.between]: [prevFrom, prevTo] } }, attributes: ['status', 'validLocation'] });
      let pc = 0, pt = 0;
      for (const l of pl) { pt++; const st = String(l.status || '').toLowerCase(); if (!st.includes('miss') && !st.includes('incomplete') && !st.includes('skip') && l.validLocation !== false) pc++; }
      prevCompletion = pt ? Math.round((pc / pt) * 1000) / 10 : 0;
    } catch { /* ignore */ }

    // ---- guard performance: avg rating → punctuality fallback ----
    let performance: any[] = [];
    try {
      // Average in SQL (AVG ... GROUP BY) instead of loading the tenant's ENTIRE
      // rating history into JS to reduce it — that scaled with total ratings.
      const fn = db.Sequelize.fn;
      const col = db.Sequelize.col;
      const ratingAgg = await db.guardRating.findAll({
        where: { tenantId },
        attributes: ['guardId', [fn('AVG', col('rating')), 'avgRating']],
        group: ['guardId'],
        raw: true,
      });
      let scored: { guardId: string; score: number }[] = (ratingAgg || [])
        .filter((r: any) => r.guardId != null)
        .map((r: any) => ({ guardId: String(r.guardId), score: Math.round(num(r.avgRating) * 20) }));
      // Fallback: punctuality per guard from this period's shifts.
      if (!scored.length) {
        const perGuard = new Map<string, { late: number; n: number }>();
        for (const r of shifts) { const k = String(r.guardNameId || ''); if (!k) continue; const g = perGuard.get(k) || { late: 0, n: 0 }; g.n++; if (num(r.lateMinutes) > LATE_THRESHOLD_MIN) g.late++; perGuard.set(k, g); }
        scored = [...perGuard.entries()].map(([guardId, g]) => ({ guardId, score: Math.max(0, Math.round(100 - (g.late / g.n) * 100)) }));
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 5);
      const ids = top.map((s) => s.guardId);
      const guards = ids.length ? await db.securityGuard.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'fullName'] }) : [];
      const nameById = new Map(guards.map((g: any) => [String(g.id), g.fullName || 'Vigilante']));
      // Photos from the polymorphic files table (belongsTo securityGuards / profileImage).
      const photoById = new Map<string, any>();
      try {
        if (ids.length) {
          const files = await db.file.findAll({ where: { tenantId, belongsTo: db.securityGuard.getTableName(), belongsToColumn: 'profileImage', belongsToId: { [Op.in]: ids } } });
          const filled = files.length ? await FileRepository.fillDownloadUrl(files) : [];
          for (const f of filled) if (!photoById.has(String(f.belongsToId))) photoById.set(String(f.belongsToId), f);
        }
      } catch { /* photos optional */ }
      performance = top.map((s) => ({ guardId: s.guardId, name: nameById.get(s.guardId) || 'Vigilante', score: s.score, photo: photoById.get(s.guardId) || null }));
    } catch { /* performance best-effort */ }

    await ApiResponseHandler.success(req, res, {
      range: { from: from.toISOString(), to: to.toISOString() },
      stats: {
        totalHours: { value: Math.round(totalHours), changePct: pct(totalHours, prevHours) },
        lateArrivals: { value: lateArrivals, changePct: pct(lateArrivals, prevLate) },
        incidents: { value: incidents, changePct: pct(incidents, prevInc) },
        cpCompletion: { value: cpCompletion, changePct: Math.round((cpCompletion - prevCompletion) * 10) / 10 },
      },
      series: {
        lateArrivals: days.map((d) => ({ date: d.toISOString(), value: lateByDay.get(dayKey(d)) || 0 })),
        incidents: days.map((d) => ({ date: d.toISOString(), value: incByDay.get(dayKey(d)) || 0 })),
        hours: days.map((d) => ({ date: d.toISOString(), value: Math.round(hoursByDay.get(dayKey(d)) || 0) })),
      },
      guardPerformance: performance,
      checkpoints: { completed, missed, incomplete, completionRate: cpCompletion },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getReports;
