/**
 * Geofence helpers (point + radius). Shared by the clock-in/out endpoints and
 * the attendance service so the distance math lives in exactly one place.
 *
 * Stations store `latitud`/`longitud` as strings and `geofenceRadius` (meters,
 * default 100). Coordinates that don't parse yield a null distance (treated as
 * "cannot validate" by callers — never a false geofence failure).
 */

/** Great-circle distance in meters between two coordinates (Haversine). */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface GeofenceResult {
  /** Meters from the station center, or null when coords are unavailable. */
  distanceM: number | null;
  /** Effective radius used (station override or provided default). */
  radiusM: number;
  /** True when a distance was computable AND it exceeds the radius. */
  outside: boolean;
}

/**
 * Evaluate a punch coordinate against a station's geofence.
 * `station` is expected to carry `latitud`, `longitud`, `geofenceRadius`.
 */
export function evaluateGeofence(
  station: { latitud?: any; longitud?: any; geofenceRadius?: any },
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  defaultRadiusM = 100,
): GeofenceResult {
  const radiusM =
    station && station.geofenceRadius != null && !isNaN(Number(station.geofenceRadius))
      ? Number(station.geofenceRadius)
      : defaultRadiusM;

  const stationLat = parseFloat(station?.latitud);
  const stationLng = parseFloat(station?.longitud);
  const lat = latitude == null ? NaN : Number(latitude);
  const lng = longitude == null ? NaN : Number(longitude);

  if (isNaN(stationLat) || isNaN(stationLng) || isNaN(lat) || isNaN(lng)) {
    return { distanceM: null, radiusM, outside: false };
  }

  const distanceM = Math.round(haversineDistance(lat, lng, stationLat, stationLng));
  return { distanceM, radiusM, outside: distanceM > radiusM };
}
