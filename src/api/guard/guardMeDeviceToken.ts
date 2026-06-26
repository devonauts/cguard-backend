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

    // Prefer attaching the FCM token to the guard's actual device record (set up
    // via /guard/me/device). Fall back to the guard's most recent device, then to
    // a token-keyed placeholder so push keeps working before device registration.
    let device = await db.deviceIdInformation.findOne({
      where: { tenantId, userId: currentUser.id, isBound: true },
    });
    if (!device) {
      device = await db.deviceIdInformation.findOne({
        where: { tenantId, userId: currentUser.id },
        order: [['lastSeenAt', 'DESC']],
      });
    }
    if (device) {
      // 'worker' tags this as a C-Guard Pro operaciones device so tenant broadcasts
      // (rondas/alarms/memos) reach it and never the Mi Seguridad client app.
      await device.update({ pushToken: String(token), app: 'worker', updatedById: currentUser.id });
    } else {
      // findOrCreate (not find-then-create) so two concurrent registrations of
      // the same token don't insert duplicate device rows.
      await db.deviceIdInformation.findOrCreate({
        where: { deviceId: String(token), tenantId },
        defaults: {
          deviceId: String(token),
          pushToken: String(token),
          app: 'worker',
          tenantId,
          userId: currentUser.id,
          createdById: currentUser.id,
          updatedById: currentUser.id,
        },
      });
    }
    return ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
