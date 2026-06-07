import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/alarm/panel/:id/zone
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const alarmPanelId = req.params.id;
    const body = req.body || {};

    // Ensure the panel belongs to this tenant.
    const panel = await db.alarmPanel.findOne({
      where: { id: alarmPanelId, tenantId },
      attributes: ['id'],
    });
    if (!panel) throw new Error404(req.language);

    const payload: any = {
      alarmPanelId,
      zoneNumber: body.zoneNumber || null,
      name: body.name || null,
      type: body.type || 'motion',
      partition: body.partition || null,
      linkedCameraId: body.linkedCameraId || null,
      bypassed: typeof body.bypassed !== 'undefined' ? body.bypassed : false,
      tenantId,
    };

    const record = await db.alarmZone.create(payload);
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
