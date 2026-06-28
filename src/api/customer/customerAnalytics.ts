/**
 * Customer analytics for the Mi Seguridad client dashboard.
 *   GET /api/customer/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Auth = the customer JWT (currentUser.clientAccountId). Every aggregate is
 * strictly scoped to the customer's OWN stations (resolved exactly like
 * customerSafety.resolveCustomerStations: stations under the customer's
 * post-sites OR directly owned via station.stationOriginId).
 *
 * Mirrors the raw-SQL aggregation style of src/api/operations/analytics.ts, but
 * filters by the customer's station id list (incidents/patrols/guardShifts all
 * carry the station FK directly) instead of by tenant-wide scope. Each query is
 * defensive (returns 0/[] on failure) so one bad table never breaks the call.
 *
 * Response:
 *   {
 *     range: { from, to, days },
 *     incidentTrend: [{ date, count }],
 *     incidentsBySeverity: { alta, media, baja },
 *     patrolCompletionRate, patrolsTotal, patrolsCompleted,
 *     avgResponseMinutes,
 *     hoursDelivered, guardsActive,
 *     byStation: [{ stationId, stationName, incidents, patrolsCompleted, hours }]
 *   }
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    clientAccountId,
  };
};

/**
 * The customer's station ids + id→name map. A station belongs to a customer if it
 * is under one of the customer's post-sites (businessInfo.clientAccountId →
 * station.postSiteId) OR directly owned via station.stationOriginId. Mirrors
 * customerSafety.resolveCustomerStations.
 */
async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();

  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));

  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }

  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'stationName'],
      })
    : [];

  return { stationIds: ids, stations };
}

/** Parse a YYYY-MM-DD (or ISO) date; falls back to `def`. */
function parseDate(v: any, def: Date): Date {
  if (!v) return def;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? def : d;
}

export default async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const sq = db.sequelize;
    const QT = sq.QueryTypes.SELECT;

    // ── date range ──────────────────────────────────────────────────────────
    const now = new Date();
    const end = parseDate(req.query.to, new Date(now));
    end.setHours(23, 59, 59, 999);
    const start = parseDate(req.query.from, new Date(now.getTime() - 29 * 86400000));
    start.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationNameById = new Map<string, string>(
      stations.map((s: any) => [String(s.id), s.stationName || 'Puesto']),
    );

    // No stations → empty (but well-formed) payload.
    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, {
        range: { from: start.toISOString(), to: end.toISOString(), days },
        incidentTrend: [],
        incidentsBySeverity: { alta: 0, media: 0, baja: 0 },
        patrolCompletionRate: 0,
        patrolsTotal: 0,
        patrolsCompleted: 0,
        avgResponseMinutes: null,
        hoursDelivered: 0,
        guardsActive: 0,
        byStation: [],
      });
    }

    const R: any = { stationIds, start, end };
    const q = async (sql: string, repl: any = R): Promise<any[]> => {
      try { return (await sq.query(sql, { replacements: repl, type: QT })) as any[]; }
      catch (e: any) { console.warn('[customerAnalytics] query failed:', e?.message || e); return []; }
    };
    const one = async (sql: string, repl: any = R) => (await q(sql, repl))[0] || {};
    const num = (v: any) => Number(v || 0);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

    // ── incident trend (per day) — uses incident.date (the canonical event time)
    const trendRows = await q(
      `SELECT DATE(date) d, COUNT(*) c FROM incidents
       WHERE stationId IN (:stationIds) AND deletedAt IS NULL
         AND date >= :start AND date <= :end
       GROUP BY DATE(date)`,
    );
    const dayKey = (v: any) => {
      const d = new Date(v);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const incMap: Record<string, number> = {};
    trendRows.forEach((r) => { incMap[dayKey(r.d)] = num(r.c); });
    const incidentTrend: { date: string; count: number }[] = [];
    const nDays = Math.min(days, 92);
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000);
      const k = dayKey(d);
      incidentTrend.push({ date: k, count: incMap[k] || 0 });
    }

    // ── incidents by severity (priority string: alta|media|baja, others bucketed) ─
    const sevRows = await q(
      `SELECT LOWER(COALESCE(priority,'')) p, COUNT(*) c FROM incidents
       WHERE stationId IN (:stationIds) AND deletedAt IS NULL
         AND date >= :start AND date <= :end
       GROUP BY LOWER(COALESCE(priority,''))`,
    );
    const incidentsBySeverity = { alta: 0, media: 0, baja: 0 };
    for (const r of sevRows) {
      const p = String(r.p || '');
      if (p === 'alta' || p === 'high' || p === 'critica' || p === 'crítica') incidentsBySeverity.alta += num(r.c);
      else if (p === 'media' || p === 'medium') incidentsBySeverity.media += num(r.c);
      else incidentsBySeverity.baja += num(r.c); // baja / low / unset / unknown
    }

    // ── patrols (completion) — patrol.stationId / .completed / .status ──────────
    const patrolAgg = await one(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN completed = 1 OR status = 'Completed' THEN 1 ELSE 0 END) completed
       FROM patrols
       WHERE stationId IN (:stationIds) AND deletedAt IS NULL
         AND scheduledTime >= :start AND scheduledTime <= :end`,
    );
    const patrolsTotal = num(patrolAgg.total);
    const patrolsCompleted = num(patrolAgg.completed);

    // ── avg response minutes — incident.date → first patrol.completionTime AFTER it
    // at the same station, within the window. Best-effort; null when not computable.
    let avgResponseMinutes: number | null = null;
    const respRows = await q(
      `SELECT AVG(diffMin) avgMin FROM (
         SELECT TIMESTAMPDIFF(
                  MINUTE, i.date,
                  (SELECT MIN(p.completionTime) FROM patrols p
                    WHERE p.stationId = i.stationId AND p.deletedAt IS NULL
                      AND p.completionTime IS NOT NULL AND p.completionTime >= i.date
                      AND p.completionTime <= :end)
                ) diffMin
         FROM incidents i
         WHERE i.stationId IN (:stationIds) AND i.deletedAt IS NULL
           AND i.date >= :start AND i.date <= :end
       ) t WHERE diffMin IS NOT NULL AND diffMin >= 0`,
    );
    if (respRows.length && respRows[0].avgMin != null) {
      avgResponseMinutes = Math.round(num(respRows[0].avgMin));
    }

    // ── hours delivered + active guards — guardShift.stationNameId / .hoursWorked
    // hoursWorked is computed at clock-out; for still-open / un-snapshotted shifts
    // we fall back to the elapsed punch-in→punch-out (or now) span.
    const hoursAgg = await one(
      `SELECT
         COALESCE(SUM(
           CASE WHEN hoursWorked IS NOT NULL THEN hoursWorked
                ELSE TIMESTAMPDIFF(SECOND, punchInTime, COALESCE(punchOutTime, NOW())) / 3600
           END
         ), 0) hours,
         COUNT(DISTINCT guardNameId) guards
       FROM guardShifts
       WHERE stationNameId IN (:stationIds) AND deletedAt IS NULL
         AND punchInTime >= :start AND punchInTime <= :end`,
    );
    const hoursDelivered = Math.round(num(hoursAgg.hours) * 10) / 10;
    const guardsActive = num(hoursAgg.guards);

    // ── per-station breakdown ───────────────────────────────────────────────────
    const sInc = await q(
      `SELECT stationId sid, COUNT(*) c FROM incidents
       WHERE stationId IN (:stationIds) AND deletedAt IS NULL
         AND date >= :start AND date <= :end
       GROUP BY stationId`,
    );
    const sPat = await q(
      `SELECT stationId sid, SUM(CASE WHEN completed = 1 OR status = 'Completed' THEN 1 ELSE 0 END) completed
       FROM patrols
       WHERE stationId IN (:stationIds) AND deletedAt IS NULL
         AND scheduledTime >= :start AND scheduledTime <= :end
       GROUP BY stationId`,
    );
    const sHours = await q(
      `SELECT stationNameId sid,
              COALESCE(SUM(
                CASE WHEN hoursWorked IS NOT NULL THEN hoursWorked
                     ELSE TIMESTAMPDIFF(SECOND, punchInTime, COALESCE(punchOutTime, NOW())) / 3600
                END
              ), 0) hours
       FROM guardShifts
       WHERE stationNameId IN (:stationIds) AND deletedAt IS NULL
         AND punchInTime >= :start AND punchInTime <= :end
       GROUP BY stationNameId`,
    );
    const idx = (rows: any[]) => {
      const m: Record<string, any> = {};
      rows.forEach((r) => { if (r.sid != null) m[String(r.sid)] = r; });
      return m;
    };
    const inM = idx(sInc), paM = idx(sPat), hoM = idx(sHours);
    const byStation = stationIds.map((sid) => ({
      stationId: sid,
      stationName: stationNameById.get(sid) || 'Puesto',
      incidents: num((inM[sid] || {}).c),
      patrolsCompleted: num((paM[sid] || {}).completed),
      hours: Math.round(num((hoM[sid] || {}).hours) * 10) / 10,
    })).sort((a, b) => b.incidents - a.incidents || b.hours - a.hours);

    return ApiResponseHandler.success(req, res, {
      range: { from: start.toISOString(), to: end.toISOString(), days },
      incidentTrend,
      incidentsBySeverity,
      patrolCompletionRate: pct(patrolsCompleted, patrolsTotal),
      patrolsTotal,
      patrolsCompleted,
      avgResponseMinutes,
      hoursDelivered,
      guardsActive,
      byStation,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
