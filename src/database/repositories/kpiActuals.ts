/**
 * Computes the REAL "actual" activity counts for a KPI over its period, scoped to
 * the KPI's guard or post-site. This replaces the old placeholder (kpi.actual was
 * never a column, and the only computation counted the empty `report` table), which
 * made every KPI report show Actual=0 / "Not Achieved".
 *
 * Period = the calendar month of the KPI's createdAt (KPIs carry no explicit
 * start/end). Only the three metrics with a populated activity source are computed:
 *   - incident  → `incident` rows              (metric: Incident Reports)
 *   - task      → completed `task` rows         (metric: Task Reports)
 *   - route     → `tagScan` patrol scans        (metric: Route Reports)
 * "Standard Reports" and "Checklist Reports" have no populated source in the schema,
 * so their actual is returned as null and the renderers hide those rows.
 *
 * A value of `null` means "not computable for this KPI's scope" (e.g. tasks are not
 * linked to a post-site, so a post-site KPI's task actual is null → hidden) — the
 * renderer must hide null rows rather than showing a misleading 0.
 */
export interface KpiActuals {
  incident: number | null;
  task: number | null;
  route: number | null;
}

export async function computeKpiActuals(db: any, kpi: any, tenantId: string): Promise<KpiActuals> {
  const result: KpiActuals = { incident: null, task: null, route: null };
  if (!db || !tenantId || !kpi) return result;

  const Op = db.Sequelize.Op;
  const created = kpi.createdAt ? new Date(kpi.createdAt) : new Date();
  const start = new Date(created.getFullYear(), created.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(created.getFullYear(), created.getMonth() + 1, 1, 0, 0, 0, 0);

  const scope = String(kpi.scope || '');
  const guardId = kpi.guardId || null;
  const postSiteId = kpi.postSiteId || null;

  // For post-site scope, tagScan only carries stationId, so resolve the post-site's
  // stations to filter patrol scans.
  let stationIds: string[] = [];
  if (scope === 'postSite' && postSiteId && db.station) {
    try {
      const st = await db.station.findAll({ where: { tenantId, postSiteId }, attributes: ['id'] });
      stationIds = (st || []).map((s: any) => String(s.id));
    } catch { /* stations optional */ }
  }

  // ── Incidents ──
  try {
    const w: any = { tenantId, createdAt: { [Op.gte]: start, [Op.lt]: end } };
    if (scope === 'guard' && guardId) w.guardNameId = guardId;
    else if (scope === 'postSite' && postSiteId) w.postSiteId = postSiteId;
    result.incident = await db.incident.count({ where: w });
  } catch { /* leave null */ }

  // ── Tasks completed this month (only scopable by guard — task has no post-site link) ──
  if (scope === 'guard' && guardId) {
    try {
      result.task = await db.task.count({
        where: {
          tenantId,
          completedByGuardId: guardId,
          status: { [Op.in]: ['completed', 'approved'] },
          dateCompletedTask: { [Op.gte]: start, [Op.lt]: end },
        },
      });
    } catch { /* leave null */ }
  } else if (scope !== 'postSite') {
    // Generic (tenant-wide) KPI: count all completed tasks in the period.
    try {
      result.task = await db.task.count({
        where: { tenantId, status: { [Op.in]: ['completed', 'approved'] }, dateCompletedTask: { [Op.gte]: start, [Op.lt]: end } },
      });
    } catch { /* leave null */ }
  }
  // (post-site scope leaves task = null → row hidden)

  // ── Patrol routes (tagScan) ──
  try {
    if (scope === 'postSite') {
      if (stationIds.length) {
        result.route = await db.tagScan.count({ where: { tenantId, stationId: { [Op.in]: stationIds }, scannedAt: { [Op.gte]: start, [Op.lt]: end } } });
      }
      // no stations → leave null (hidden)
    } else if (scope === 'guard' && guardId) {
      result.route = await db.tagScan.count({ where: { tenantId, securityGuardId: guardId, scannedAt: { [Op.gte]: start, [Op.lt]: end } } });
    } else {
      result.route = await db.tagScan.count({ where: { tenantId, scannedAt: { [Op.gte]: start, [Op.lt]: end } } });
    }
  } catch { /* leave null */ }

  return result;
}

export default computeKpiActuals;
