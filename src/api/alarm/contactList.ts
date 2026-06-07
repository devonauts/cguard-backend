import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// GET /tenant/:tenantId/alarm/panel/:id/contacts
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const panel = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!panel) throw new Error404();

    const rows = await db.alarmContact.findAll({
      where: { alarmPanelId: panel.id, tenantId },
      order: [['callOrder', 'ASC'], ['createdAt', 'ASC']],
    });

    // SECURITY: never return the verbal passcode.
    const out = (rows || []).map((r: any) => {
      const p = typeof r.get === 'function' ? r.get({ plain: true }) : r;
      delete p.passcode;
      return p;
    });

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
