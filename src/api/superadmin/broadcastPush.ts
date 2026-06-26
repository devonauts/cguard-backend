/**
 * SuperAdmin · platform-wide broadcast push.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Sends one notification to EVERY registered device across ALL tenants — there is
 * no tenant filter on purpose. This is the only place that can reach the whole
 * fleet at once, so every send is written to the superadmin audit trail.
 *
 *   GET  /broadcast-push/audience   -> per-app counts + fcm/apns configured flags
 *   POST /broadcast-push            -> { title, body, link?, timeSensitive?, app? }
 *                                      app: 'worker' | 'client' | omit (both apps)
 */
import ApiResponseHandler from '../apiResponseHandler';
import { db, writeAudit } from '../../services/superadmin/superadminHelpers';
import { pushToAll, countAllDevices, isPushConfigured, BroadcastApp } from '../../services/pushService';
import { isApnsConfigured } from '../../services/apnsService';

export default (router) => {
  // Preview the blast radius before sending.
  router.get('/broadcast-push/audience', async (req, res) => {
    try {
      const counts = await countAllDevices(db(req));
      await ApiResponseHandler.success(req, res, {
        ...counts,
        fcmConfigured: isPushConfigured(),
        apnsConfigured: isApnsConfigured(),
      });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/broadcast-push', async (req, res) => {
    try {
      const body = req.body || {};
      const title = (body.title || '').toString().trim();
      const message = (body.body || '').toString().trim();
      if (!title || !message) {
        return ApiResponseHandler.error(req, res, {
          code: 400,
          message: 'title and body are required',
        });
      }
      // Optional app target: 'worker' (C-Guard Pro) or 'client' (Mi Seguridad); omit for both.
      const app: BroadcastApp | undefined =
        body.app === 'worker' || body.app === 'client' ? body.app : undefined;

      const data: Record<string, string> = {};
      // The mobile app routes a tapped notification by its `link` data field.
      if (body.link) data.link = String(body.link).trim();

      const result: any = await pushToAll(
        db(req),
        { title, body: message, data, timeSensitive: !!body.timeSensitive },
        app,
      );

      await writeAudit(req, {
        action: 'broadcastPush.send',
        targetType: 'devices',
        statusCode: 200,
        details: {
          title,
          app: app || 'both',
          devices: result.devices,
          sent: result.sent,
          fcm: result.fcm,
          apns: result.apns,
          timeSensitive: !!body.timeSensitive,
        },
      });

      await ApiResponseHandler.success(req, res, result);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
