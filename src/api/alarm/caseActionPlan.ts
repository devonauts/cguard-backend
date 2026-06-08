/**
 * GET /tenant/:tenantId/alarm/case/:id/action-plan
 * Resolves the applicable action plan for a case (panel-specific + category match
 * preferred, then panel default, then tenant default) and returns its ordered
 * steps plus the case's step-completion progress. Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const c = await db.alarmCase.findOne({ where: { id: req.params.id, tenantId } });
    if (!c) throw new Error404();

    const plans = await db.actionPlan.findAll({ where: { tenantId, active: true } });
    const applicable = (plans || []).filter(
      (p: any) =>
        (p.alarmPanelId === c.alarmPanelId || p.alarmPanelId == null) &&
        (p.appliesToCategory === c.category || p.appliesToCategory == null),
    );
    const score = (p: any) =>
      (p.alarmPanelId === c.alarmPanelId ? 2 : 0) + (p.appliesToCategory === c.category ? 1 : 0);
    applicable.sort((a: any, b: any) => score(b) - score(a));
    const plan = applicable[0] || null;

    let steps: any[] = [];
    if (plan && Array.isArray(plan.steps)) steps = plan.steps;
    else if (plan && typeof plan.steps === 'string') {
      try { steps = JSON.parse(plan.steps); } catch { steps = []; }
    }

    await ApiResponseHandler.success(req, res, {
      plan: plan ? { id: plan.id, name: plan.name } : null,
      steps,
      progress: c.stepProgress || {},
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
