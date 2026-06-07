import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// GET /tenant/:tenantId/alarm/panel/:id/zones
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const alarmPanelId = req.params.id;

    // Ensure the panel belongs to this tenant before listing its zones.
    const panel = await db.alarmPanel.findOne({
      where: { id: alarmPanelId, tenantId },
      attributes: ['id'],
    });
    if (!panel) throw new Error404(req.language);

    const rows = await db.alarmZone.findAll({
      where: { alarmPanelId, tenantId },
      order: [['zoneNumber', 'ASC']],
    });
    const out = (rows || []).map((r: any) =>
      typeof r.get === 'function' ? r.get({ plain: true }) : r,
    );

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
