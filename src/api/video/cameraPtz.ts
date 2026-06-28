/**
 * POST /tenant/:tenantId/video/camera/:id/ptz
 * Body: { pan?, tilt?, zoom?, stop?: boolean }   (velocities -1..1)
 *
 * Pan/tilt/zoom a PTZ camera via ONVIF ContinuousMove; { stop: true } halts motion.
 * The DVR's ONVIF credentials are the device username/password (decrypted).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { profileTokenForChannel, ptzMove, ptzStop, type PtzCreds } from './_onvif';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const camera = await db.videoCamera.findOne({
      where: { id: req.params.id, tenantId },
      include: [{ model: db.videoDevice, as: 'device', required: false }],
    });
    if (!camera) throw new Error404();
    const dev = camera.device;

    // Prefer the device record; fall back to the credentials embedded in the camera's
    // RTSP url (some cameras are orphaned — their device was deleted but streaming still
    // works because the rtspUrl carries host + user:pass).
    let creds: PtzCreds | null = null;
    if (dev && dev.host && dev.username) {
      creds = { host: String(dev.host), username: String(dev.username), password: String(dev.password || '') };
    } else if (camera.rtspUrl) {
      const m = String(camera.rtspUrl).match(/^rtsps?:\/\/([^:@/]+):([^@/]*)@([^:/]+)/i);
      if (m) creds = { host: m[3], username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) };
    }
    if (!creds) {
      return ApiResponseHandler.error(req, res, new Error('La cámara no tiene credenciales para PTZ'));
    }
    const token = await profileTokenForChannel(creds, camera.channel);
    if (!token) {
      return ApiResponseHandler.error(req, res, new Error('No se pudo resolver el perfil ONVIF (PTZ no disponible)'));
    }

    const body = req.body || {};
    let ok: boolean;
    if (body.stop) {
      ok = await ptzStop(creds, token);
    } else {
      ok = await ptzMove(creds, token, { pan: body.pan, tilt: body.tilt, zoom: body.zoom });
    }

    await ApiResponseHandler.success(req, res, { ok });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
