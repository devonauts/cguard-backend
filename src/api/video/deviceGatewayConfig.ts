/**
 * GET /tenant/:tenantId/video/device/:id/gateway-config
 * Returns a ready-to-paste go2rtc `streams:` config for this device's cameras —
 * each camera mapped to its LAN RTSP source. Deploy go2rtc (cloud or on-site) with
 * this config; it pulls the RTSP and serves WebRTC/HLS the CRM plays.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { buildRtspUrl, streamName } from './_videoUrl';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const device = await db.videoDevice.findOne({ where: { id: req.params.id, tenantId } });
    if (!device) { const err: any = new Error('Not found'); err.code = 404; throw err; }

    const cameras = await db.videoCamera.findAll({ where: { videoDeviceId: device.id, tenantId }, order: [['channel', 'ASC']] });

    const lines: string[] = ['streams:'];
    for (const cam of cameras || []) {
      const rtsp = cam.rtspUrl || buildRtspUrl(device, cam.channel);
      if (rtsp) lines.push(`  ${streamName(cam.id)}: ${rtsp}`);
    }
    const yaml = lines.join('\n') + '\n';

    await ApiResponseHandler.success(req, res, {
      deviceId: device.id,
      deviceName: device.name,
      cameraCount: (cameras || []).length,
      gatewayBase: device.streamGatewayBase || null,
      format: device.streamFormat || 'hls',
      yaml,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
