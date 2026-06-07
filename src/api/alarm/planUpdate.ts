import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// PUT /tenant/:tenantId/alarm/action-plan/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const raw = (req.body && req.body.data) || req.body || {};

    const plan = await db.actionPlan.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!plan) throw new Error404();

    const mapped: any = {};
    if (raw.name !== undefined) mapped.name = raw.name;
    if (raw.alarmPanelId !== undefined) mapped.alarmPanelId = raw.alarmPanelId || null;
    if (raw.appliesToCategory !== undefined) mapped.appliesToCategory = raw.appliesToCategory || null;
    if (raw.steps !== undefined) mapped.steps = Array.isArray(raw.steps) ? raw.steps : [];
    if (raw.active !== undefined) mapped.active = !!raw.active;

    await plan.update(mapped);

    const plain = typeof plan.get === 'function' ? plan.get({ plain: true }) : plan;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
