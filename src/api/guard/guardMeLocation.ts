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
import { getPostRules } from '../../services/postRulesService';
import { evaluateGeofence } from '../../lib/geofence';
import { dispatch } from '../../lib/notificationDispatcher';

function num(v: any): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Consecutive outside pings required before alerting (GPS-jitter guard). */
const OUTSIDE_STREAK_TO_ALERT = 2;

/**
 * Geofence exit/return alerting (postRules.geofenceExitAlert). Compares this
 * ping against the shift's station fence and dispatches attendance-exceptions
 * notifications on transitions. Hysteresis: alert only after N consecutive
 * outside pings; return alerts fire on the first inside ping. Best-effort —
 * must never break the telemetry write.
 */
async function evaluateGeofenceAlerts(
  db: any,
  tenantId: string,
  securityGuardId: string,
  lat: number,
  lng: number,
): Promise<void> {
  const rules = await getPostRules(db, tenantId);
  if (!rules.geofenceExitAlert) return;

  const shift = await db.guardShift.findOne({
    where: { tenantId, guardNameId: securityGuardId, punchOutTime: null },
    attributes: ['id', 'stationNameId', 'liveGeofenceOutside', 'liveGeofenceStreak'],
  });
  if (!shift || !shift.stationNameId) return;

  const station = await db.station.findByPk(shift.stationNameId, {
    attributes: ['id', 'stationName', 'latitud', 'longitud', 'geofenceRadius', 'geofencePolygon', 'isMobile', 'postSiteId'],
  });
  // Mobile posts aren't geofenced; stations without coordinates can't be.
  if (!station || station.isMobile || station.latitud == null || station.longitud == null) return;

  const geo = evaluateGeofence(station, lat, lng, 100);

  const wasOutside = shift.liveGeofenceOutside; // null = unknown yet
  const streak = Number(shift.liveGeofenceStreak) || 0;

  if (geo.outside) {
    const nextStreak = streak + 1;
    if (nextStreak >= OUTSIDE_STREAK_TO_ALERT && wasOutside !== true) {
      await shift.update({ liveGeofenceOutside: true, liveGeofenceStreak: nextStreak });
      const guard = await db.securityGuard.findByPk(securityGuardId, { attributes: ['fullName'] });
      dispatch('attendance.geofence_exit', {
        guardName: guard?.fullName || 'Vigilante',
        stationName: station.stationName || null,
        distanceM: geo.distanceM != null ? Math.round(geo.distanceM) : null,
      }, {
        database: db,
        tenantId,
        sourceEntityType: 'guardShift',
        sourceEntityId: shift.id,
        assignedPostSiteId: station.postSiteId || undefined,
      }).catch(() => {});
    } else {
      await shift.update({ liveGeofenceStreak: nextStreak });
    }
  } else {
    if (wasOutside === true) {
      await shift.update({ liveGeofenceOutside: false, liveGeofenceStreak: 0 });
      if (rules.geofenceReturnAlert) {
        const guard = await db.securityGuard.findByPk(securityGuardId, { attributes: ['fullName'] });
        dispatch('attendance.geofence_return', {
          guardName: guard?.fullName || 'Vigilante',
          stationName: station.stationName || null,
        }, {
          database: db,
          tenantId,
          sourceEntityType: 'guardShift',
          sourceEntityId: shift.id,
          assignedPostSiteId: station.postSiteId || undefined,
        }).catch(() => {});
      }
    } else if (streak !== 0 || wasOutside == null) {
      await shift.update({ liveGeofenceOutside: false, liveGeofenceStreak: 0 });
    }
  }
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

    // Single atomic UPDATE on the open shift — no SELECT-then-save. This is the
    // hottest write in the platform (every on-duty guard pings on a timer), and
    // a findOne without attributes would drag the row's TEXT blobs (selfie,
    // sessions JSON, checklist) over the wire per ping. affectedRows === 0 means
    // no open shift → same no-op { ok: false } as before. Paranoid (deletedAt)
    // filtering is applied by Model.update automatically.
    const battery = num(body.battery);
    const [affected] = await db.guardShift.update(
      {
        liveLatitude: lat,
        liveLongitude: lng,
        liveSpeed: num(body.speed),
        liveHeading: num(body.heading),
        liveAccuracy: num(body.accuracy),
        // battery may arrive 0..1 (fraction) or 0..100 — normalize to whole %.
        liveBattery: battery == null ? null : Math.round(battery <= 1 ? battery * 100 : battery),
        liveLocationAt: new Date(),
      },
      { where: { tenantId, guardNameId: securityGuard.id, punchOutTime: null } },
    );
    if (!affected) {
      return ApiResponseHandler.success(req, res, { ok: false });
    }

    // Append an immutable breadcrumb so the CRM can draw the ACTUAL route walked
    // (the live* columns above only keep the last-known dot). Best-effort — a
    // trail insert must never break telemetry. Only when we have a real fix.
    // Geofence exit/return alerts (Reglas globales de puestos). Best-effort.
    if (lat != null && lng != null) {
      try {
        await evaluateGeofenceAlerts(db, tenantId, securityGuard.id, lat, lng);
      } catch { /* alerting must never break telemetry */ }
    }

    if (lat != null && lng != null && db.locationPing) {
      try {
        const recAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
        await db.locationPing.create({
          tenantId,
          subjectType: 'guard',
          userId,
          securityGuardId: securityGuard.id,
          latitude: lat,
          longitude: lng,
          accuracy: num(body.accuracy),
          speed: num(body.speed),
          heading: num(body.heading),
          battery: battery == null ? null : Math.round(battery <= 1 ? battery * 100 : battery),
          recordedAt: Number.isNaN(recAt.getTime()) ? new Date() : recAt,
        });
      } catch { /* breadcrumb is best-effort */ }
    }

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
