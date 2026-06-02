/**
 * POST /api/tenant/:tenantId/guard/me/device-token  { token }
 *
 * Registers the guard's FCM device token (for push). Idempotent per token.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const token = (req.body.data || req.body || {}).token;
    if (!token) throw new Error400(req.language, 'device.tokenRequired');

    const existing = await db.deviceIdInformation.findOne({
      where: { deviceId: String(token), tenantId },
    });
    if (!existing) {
      await db.deviceIdInformation.create({
        deviceId: String(token),
        tenantId,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      });
    }
    return ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
