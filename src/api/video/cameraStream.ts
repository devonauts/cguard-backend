/**
 * GET /tenant/:tenantId/video/camera/:id/stream
 *
 * Resolve the playback stream descriptor for a camera. Returns the media
 * gateway HLS/WebRTC url plus an optional snapshot url. Tenant-scoped;
 * requires businessInfoRead.
 *
 * Response: { type: 'hls'|'webrtc'|'none', url: string|null, snapshotUrl: string|null }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const camera = await db.videoCamera.findOne({
      where: { id: req.params.id, tenantId },
      include: [{ model: db.videoDevice, as: 'device', required: false }],
    });

    if (!camera) throw new Error404();

    const url = camera.streamUrl || null;
    const snapshotUrl = camera.snapshotUrl || null;

    // Infer the stream type from the device protocol / url shape.
    let type: 'hls' | 'webrtc' | 'none' = 'none';
    if (url) {
      const protocol = (camera.device && camera.device.protocol) || '';
      if (protocol === 'webrtc' || /^webrtc:/i.test(url)) {
        type = 'webrtc';
      } else {
        // Default playable web stream is HLS (.m3u8 from the media gateway).
        type = 'hls';
      }
    }

    await ApiResponseHandler.success(req, res, { type, url, snapshotUrl });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
