import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { encrypt } from '../../lib/secretBox';

// POST /tenant/:tenantId/video/device
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const payload: any = {
      name: body.name,
      type: body.type || 'dvr',
      brand: body.brand || null,
      model: body.model || null,
      host: body.host || null,
      port: typeof body.port !== 'undefined' && body.port !== null ? Number(body.port) : 554,
      httpPort: typeof body.httpPort !== 'undefined' && body.httpPort !== null ? Number(body.httpPort) : 80,
      username: body.username || null,
      // Encrypted at rest (secretBox); decrypted only when building the RTSP URL.
      password: body.password ? encrypt(String(body.password)) : null,
      channels: typeof body.channels !== 'undefined' && body.channels !== null ? Number(body.channels) : 1,
      protocol: body.protocol || 'rtsp',
      status: body.status || 'unknown',
      lastSeenAt: body.lastSeenAt || null,
      postSiteId: body.postSiteId || null,
      stationId: body.stationId || null,
      notes: body.notes || null,
      connectionMode: body.connectionMode === 'relay' ? 'relay' : 'direct',
      relaySiteId: body.relaySiteId || null,
      active: typeof body.active !== 'undefined' ? body.active : true,
      tenantId,
      createdById: currentUser && currentUser.id,
      updatedById: currentUser && currentUser.id,
    };

    const record = await db.videoDevice.create(payload);
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.password;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
