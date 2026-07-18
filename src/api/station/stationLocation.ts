import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Set ONLY a station's exact coordinates (and optional geofence radius) from the
 * "Puestos y cobertura" map — the user drops/drags the pin to the precise spot.
 * Dedicated endpoint so a pin move never touches schedule/assignment fields.
 */
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const raw = req.body?.data || req.body || {};

    const station: any = await req.database.station.findByPk(req.params.id);
    if (!station || (tenantId && station.tenantId && station.tenantId !== tenantId)) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }

    const toNum = (v: any) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(String(v).replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };

    const patch: any = {};
    if (Object.prototype.hasOwnProperty.call(raw, 'latitud') || Object.prototype.hasOwnProperty.call(raw, 'lat')) {
      patch.latitud = toNum(raw.latitud ?? raw.lat);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'longitud') || Object.prototype.hasOwnProperty.call(raw, 'lng')) {
      patch.longitud = toNum(raw.longitud ?? raw.lng);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'geofenceRadius')) {
      const r = toNum(raw.geofenceRadius);
      if (r != null) patch.geofenceRadius = Math.round(r);
    }

    await station.update(patch);

    return ApiResponseHandler.success(req, res, {
      id: station.id,
      latitud: station.latitud,
      longitud: station.longitud,
      geofenceRadius: station.geofenceRadius,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
