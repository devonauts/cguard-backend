/**
 * POST /api/tenant/:tenantId/guard/me/location
 *
 * Live-telemetry ping from the worker app while the guard is on duty. Updates
 * the open shift's live* columns so the supervisor's Guard Detail shows the
 * CURRENT battery / GPS / speed (not just the clock-in snapshot). Cheap + idem-
 * potent; no-op (200) when the guard has no open shift.
 *
 * Body: { latitude, longitude, speed?, heading?, accuracy?, battery? }
 *   speed in m/s, heading in degrees, battery 0..100.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

function num(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const body = req.body.data || req.body || {};

    const lat = num(body.latitude ?? body.lat);
    const lng = num(body.longitude ?? body.lng);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });
    if (!securityGuard) {
      // No profile → nothing to attach telemetry to. Not an error for a ping.
      return ApiResponseHandler.success(req, res, { ok: false });
    }

    const open = await db.guardShift.findOne({
      where: { tenantId, guardNameId: securityGuard.id, punchOutTime: null },
      order: [['punchInTime', 'DESC']],
    });
    if (!open) {
      return ApiResponseHandler.success(req, res, { ok: false });
    }

    const battery = num(body.battery);
    await open.update({
      liveLatitude: lat,
      liveLongitude: lng,
      liveSpeed: num(body.speed),
      liveHeading: num(body.heading),
      liveAccuracy: num(body.accuracy),
      // battery may arrive 0..1 (fraction) or 0..100 — normalize to whole %.
      liveBattery: battery == null ? null : Math.round(battery <= 1 ? battery * 100 : battery),
      liveLocationAt: new Date(),
    });

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
