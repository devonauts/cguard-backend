import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// PUT /tenant/:tenantId/video/device/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const record = await db.videoDevice.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    // Only assign provided fields; never blank-out password when omitted.
    const updatable = [
      'name', 'type', 'brand', 'model', 'host', 'port', 'httpPort', 'username',
      'channels', 'protocol', 'status', 'lastSeenAt', 'postSiteId', 'stationId',
      'notes', 'active',
    ];
    const updateData: any = { updatedById: currentUser && currentUser.id };
    updatable.forEach((f) => {
      if (typeof body[f] !== 'undefined') updateData[f] = body[f];
    });
    // Only overwrite the password when a non-empty value is explicitly sent.
    if (typeof body.password !== 'undefined' && body.password !== null && body.password !== '') {
      updateData.password = body.password;
    }

    await record.update(updateData);

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.password;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
