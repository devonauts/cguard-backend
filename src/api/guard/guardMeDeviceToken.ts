/**
 * POST /api/tenant/:tenantId/guard/me/device-token  { token, deviceId? }
 *
 * Registers the guard's FCM device token (for push). When the app sends its
 * stable `deviceId` (@capacitor/device getId) we key on it — the SAME key
 * `registerGuardDevice` (/guard/me/device) uses — so the token always lands on
 * the guard's real device row instead of spawning a duplicate token-keyed row.
 * Idempotent.
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
    const body = req.body.data || req.body || {};
    const token = body.token;
    const deviceId = body.deviceId ? String(body.deviceId) : null;
    if (!token) throw new Error400(req.language, 'device.tokenRequired');

    // Resolve the row to attach the token to, in priority:
    //  1) the stable device row (same key as /guard/me/device) — no duplicates,
    //  2) the guard's bound device, 3) their most-recent device.
    let device: any = null;
    if (deviceId) {
      device = await db.deviceIdInformation.findOne({ where: { tenantId, deviceId } });
    }
    if (!device) {
      device = await db.deviceIdInformation.findOne({
        where: { tenantId, userId: currentUser.id, isBound: true },
      });
    }
    if (!device) {
      device = await db.deviceIdInformation.findOne({
        where: { tenantId, userId: currentUser.id },
        order: [['lastSeenAt', 'DESC']],
      });
    }
    if (device) {
      // 'worker' tags this as a C-Guard Pro operaciones device so tenant broadcasts
      // (rondas/alarms/memos) reach it and never the Mi Seguridad client app.
      await device.update({
        pushToken: String(token),
        app: 'worker',
        userId: currentUser.id,
        lastSeenAt: new Date(),
        updatedById: currentUser.id,
      });
    } else {
      // No device row yet (token arrived before /guard/me/device). Create one keyed
      // by the stable deviceId when known, else by the token. findOrCreate so two
      // concurrent registrations don't insert duplicates.
      await db.deviceIdInformation.findOrCreate({
        where: { tenantId, deviceId: deviceId || String(token) },
        defaults: {
          deviceId: deviceId || String(token),
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
