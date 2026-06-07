import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// PUT /tenant/:tenantId/alarm/zone/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const body = req.body || {};

    const record = await db.alarmZone.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) throw new Error404(req.language);

    const updatable = [
      'zoneNumber', 'name', 'type', 'partition', 'linkedCameraId', 'bypassed',
    ];
    const updateData: any = {};
    updatable.forEach((f) => {
      if (typeof body[f] !== 'undefined') updateData[f] = body[f];
    });

    await record.update(updateData);

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
