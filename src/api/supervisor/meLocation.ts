/**
 * POST /supervisor/me/location { latitude, longitude, speed? } — a live position
 * ping from the supervisor app while on duty. Updates supervisorProfile.lat/lng
 * (the CRM live map reads these) and emits a realtime `location:update` for the
 * Control Center's supervisor layer. Best-effort; never 500s the app.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { emitToSupervision } from '../../lib/realtime';

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
      const name = req.currentUser?.fullName || req.currentUser?.email || 'Supervisor';
      // Supervision room only (Control Center dashboards) — NOT the whole
      // tenant room: at scale a tenant-wide emit fanned every supervisor GPS
      // ping out to every connected guard phone. Payload keeps the original
      // fields and adds the id/lat/lng/label aliases the CRM map upserts by
      // (same shape the demo orchestrator emits, which the CRM was built on).
      emitToSupervision(tenantId, 'location:update', {
        id: `sup-${userId}`,
        kind: 'supervisor',
        userId,
        name,
        label: name,
        latitude: Number(lat),
        longitude: Number(lng),
        lat: Number(lat),
        lng: Number(lng),
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
