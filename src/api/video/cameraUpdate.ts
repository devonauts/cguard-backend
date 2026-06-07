/**
 * PUT /tenant/:tenantId/video/camera/:id
 *
 * Update an existing video camera for the current tenant. Tenant-scoped;
 * requires businessInfoEdit. Only known camera fields are mutated.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoEdit,
    );

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const camera = await db.videoCamera.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!camera) throw new Error404();

    const raw = req.body.data || req.body || {};

    const mapped: any = {};
    const fields = [
      'channel',
      'name',
      'rtspUrl',
      'streamUrl',
      'snapshotUrl',
      'postSiteId',
      'stationId',
      'enabled',
      'status',
    ];
    for (const f of fields) {
      if (raw[f] !== undefined) mapped[f] = raw[f];
    }

    if (req.currentUser && req.currentUser.id) {
      mapped.updatedById = req.currentUser.id;
    }

    await camera.update(mapped);

    const result = await db.videoCamera.findOne({
      where: { id: camera.id, tenantId },
      include: [{ model: db.videoDevice, as: 'device', required: false }],
    });

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
