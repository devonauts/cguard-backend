import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

// POST /tenant/:tenantId/alarm/action-plan
// Body: { name, alarmPanelId, appliesToCategory, steps:[{order,type,detail}], active }
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const raw = (req.body && req.body.data) || req.body || {};

    if (!raw.name) {
      throw new Error400(req.language, 'errors.validation.missingFields');
    }

    const record = await db.actionPlan.create({
      name: raw.name,
      alarmPanelId: raw.alarmPanelId || null,
      appliesToCategory: raw.appliesToCategory || null,
      steps: Array.isArray(raw.steps) ? raw.steps : [],
      active: typeof raw.active !== 'undefined' ? !!raw.active : true,
      tenantId,
      createdById: currentUser && currentUser.id,
    });

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
