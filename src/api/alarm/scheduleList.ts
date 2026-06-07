import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// GET /tenant/:tenantId/alarm/panel/:id/schedules
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const panel = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!panel) throw new Error404();

    const rows = await db.openCloseSchedule.findAll({
      where: { alarmPanelId: panel.id, tenantId },
      order: [['dayOfWeek', 'ASC'], ['openTime', 'ASC']],
    });

    const out = (rows || []).map((r: any) =>
      typeof r.get === 'function' ? r.get({ plain: true }) : r,
    );

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
