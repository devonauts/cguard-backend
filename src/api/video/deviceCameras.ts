import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// Build a default RTSP url for a device channel when we have enough info.
function buildRtspUrl(device: any, channel: number): string | null {
  if (!device.host) return null;
  const auth = device.username
    ? `${encodeURIComponent(device.username)}:${encodeURIComponent(device.password || '')}@`
    : '';
  const port = device.port || 554;
  return `rtsp://${auth}${device.host}:${port}/ch${channel}`;
}

// POST /tenant/:tenantId/video/device/:id/cameras
// Auto-create videoCamera rows for channels 1..N if missing; return all cameras.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const device = await db.videoDevice.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!device) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const channelCount = Math.max(1, Number(device.channels) || 1);

    // Existing cameras for this device, keyed by channel.
    const existing = await db.videoCamera.findAll({
      where: { videoDeviceId: device.id, tenantId },
    });
    const byChannel: Record<number, any> = {};
    (existing || []).forEach((c: any) => {
      byChannel[Number(c.channel)] = c;
    });

    // Create any missing channels 1..N.
    for (let ch = 1; ch <= channelCount; ch += 1) {
      if (!byChannel[ch]) {
        const created = await db.videoCamera.create({
          videoDeviceId: device.id,
          channel: ch,
          name: `${device.name} - Canal ${ch}`,
          rtspUrl: buildRtspUrl(device, ch),
          postSiteId: device.postSiteId || null,
          stationId: device.stationId || null,
          enabled: true,
          status: 'unknown',
          tenantId,
        });
        byChannel[ch] = created;
      }
    }

    const rows = await db.videoCamera.findAll({
      where: { videoDeviceId: device.id, tenantId },
      order: [['channel', 'ASC']],
    });
    const out = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));

    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
