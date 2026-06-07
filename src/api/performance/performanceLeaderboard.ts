/**
 * Guard performance leaderboard for the "Guardias" analytics page.
 * GET /api/tenant/:tenantId/performance/guards?period=30
 *
 * Runs the SAME official performance algorithm (GuardPerformanceService) used by
 * the worker app for every active guard, so the analytics scores match exactly.
 * Computed in bounded-concurrency chunks to avoid hammering the DB.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardPerformanceService from '../../services/guardPerformanceService';

const CHUNK = 6;     // guards scored in parallel per batch
const MAX_GUARDS = 200;

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);

    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    if (!tenantId) return ApiResponseHandler.success(req, res, { guards: [] });

    const periodDays = Math.min(180, Math.max(7, Number(req.query.period) || 30));

    const guards = await db.securityGuard.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
      limit: MAX_GUARDS,
    });

    const svc = new GuardPerformanceService(req);
    const results: any[] = [];
    for (let i = 0; i < guards.length; i += CHUNK) {
      const slice = guards.slice(i, i + CHUNK);
      const scored = await Promise.all(slice.map(async (g: any) => {
        try {
          const p: any = await svc.forSecurityGuard(g.id, periodDays);
          return {
            id: g.id,
            name: g.fullName || '—',
            score: p.score,
            base: p.base,
            tier: p.tier,
            hasData: p.hasData,
            attendanceRate: p.stats ? p.stats.attendanceRate : null,
            shiftsWorked: p.stats ? p.stats.shiftsWorked : null,
            onTimeShifts: p.stats ? p.stats.onTimeShifts : null,
            absences: p.penalty ? p.penalty.absences : 0,
            tardies: p.penalty ? p.penalty.tardies : 0,
            components: (p.components || []).map((c: any) => ({ key: c.key, score: c.score, weight: c.weight })),
          };
        } catch (e: any) {
          console.warn('[perf leaderboard] guard scoring failed:', g.id, e?.message || e);
          return { id: g.id, name: g.fullName || '—', score: null, tier: 'poor', hasData: false, components: [] };
        }
      }));
      results.push(...scored);
    }

    // Guards WITH data first, sorted by score desc; no-data guards last.
    results.sort((a, b) => (Number(b.hasData) - Number(a.hasData)) || ((b.score || 0) - (a.score || 0)));

    const withData = results.filter((r) => r.hasData);
    const averageScore = withData.length
      ? Math.round(withData.reduce((s, r) => s + (r.score || 0), 0) / withData.length)
      : null;

    return ApiResponseHandler.success(req, res, {
      period: periodDays,
      averageScore,
      counts: {
        total: results.length,
        scored: withData.length,
        excellent: withData.filter((r) => r.tier === 'excellent').length,
        good: withData.filter((r) => r.tier === 'good').length,
        fair: withData.filter((r) => r.tier === 'fair').length,
        poor: withData.filter((r) => r.tier === 'poor').length,
      },
      guards: results,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
