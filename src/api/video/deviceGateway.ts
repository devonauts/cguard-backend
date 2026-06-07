/**
 * PUT /tenant/:tenantId/video/device/:id/gateway
 * Body: { streamGatewayBase: string, streamFormat?: 'hls'|'webrtc' }
 *
 * Sets the media-gateway base URL for a device and re-points every camera's
 * browser streamUrl at the gateway (go2rtc HLS/WebRTC playback). After this, the
 * Monitoreo grid plays the cameras live (once the gateway is reachable + running).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { gatewayPlaybackUrl } from './_videoUrl';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const device = await db.videoDevice.findOne({ where: { id: req.params.id, tenantId } });
    if (!device) { const err: any = new Error('Not found'); err.code = 404; throw err; }

    const body = req.body || {};
    const base = (body.streamGatewayBase || '').trim();
    const format = body.streamFormat === 'webrtc' ? 'webrtc' : 'hls';

    await device.update({ streamGatewayBase: base || null, streamFormat: format, updatedById: req.currentUser && req.currentUser.id });

    const cameras = await db.videoCamera.findAll({ where: { videoDeviceId: device.id, tenantId } });
    let updated = 0;
    for (const cam of cameras || []) {
      const streamUrl = base ? gatewayPlaybackUrl(base, cam.id, format) : null;
      await cam.update({ streamUrl });
      updated += 1;
    }

    await ApiResponseHandler.success(req, res, { ok: true, streamGatewayBase: base || null, streamFormat: format, camerasUpdated: updated });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
