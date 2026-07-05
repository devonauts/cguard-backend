/**
 * POST /supervisor/me/location { latitude, longitude, speed? } — a live position
 * ping from the supervisor app while on duty. Updates supervisorProfile.lat/lng
 * (the CRM live map reads these) and emits a realtime `location:update` for the
 * Control Center's supervisor layer. Best-effort; never 500s the app.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { emitToTenant } from '../../lib/realtime';

export const updateMyLocation = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const data = (req.body && req.body.data) || req.body || {};
    const lat = data.latitude ?? data.lat;
    const lng = data.longitude ?? data.lng;

    if (lat == null || lng == null) {
      await ApiResponseHandler.success(req, res, { ok: false });
      return;
    }

    await db.supervisorProfile.update(
      { latitude: lat, longitude: lng },
      { where: { tenantId, supervisorUserId: userId } },
    );

    try {
      emitToTenant(tenantId, 'location:update', {
        kind: 'supervisor',
        userId,
        name: req.currentUser?.fullName || req.currentUser?.email || 'Supervisor',
        latitude: Number(lat),
        longitude: Number(lng),
        speed: data.speed ?? null,
        at: new Date().toISOString(),
      });
    } catch { /* realtime best-effort */ }

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default updateMyLocation;
