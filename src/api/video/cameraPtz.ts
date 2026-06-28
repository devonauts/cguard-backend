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
    if (!dev || !dev.host || !dev.username) {
      return ApiResponseHandler.error(req, res, new Error('La cámara no tiene un dispositivo/credenciales para PTZ'));
    }

    const creds: PtzCreds = { host: String(dev.host), username: String(dev.username), password: String(dev.password || '') };
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
