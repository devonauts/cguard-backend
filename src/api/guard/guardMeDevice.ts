/**
 * POST /api/tenant/:tenantId/guard/me/device
 *
 * The app reports the guard's device identity (stable deviceId from
 * @capacitor/device + model / OS / app version, and optionally the FCM token).
 * Applies the bind/flag policy and returns whether this is the bound device.
 *
 * Body: { deviceId, platform?, model?, manufacturer?, osVersion?, appVersion?, pushToken? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { registerGuardDevice } from '../../services/guardDeviceService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const body = req.body.data || req.body || {};

    if (!body.deviceId) throw new Error400(req.language, 'device.deviceIdRequired');

    const { record, bound, mismatch } = await registerGuardDevice(
      db,
      tenantId,
      currentUser.id,
      {
        deviceId: body.deviceId,
        platform: body.platform,
        model: body.model,
        manufacturer: body.manufacturer,
        osVersion: body.osVersion,
        appVersion: body.appVersion,
        pushToken: body.pushToken,
      },
    );

    return ApiResponseHandler.success(req, res, {
      id: record.id,
      bound,
      mismatch,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
