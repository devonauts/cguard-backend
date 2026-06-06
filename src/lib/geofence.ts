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
  /** True when a distance was computable AND it exceeds the radius/polygon. */
  outside: boolean;
  /** 'polygon' when a station polygon was used, else 'radius'. */
  mode?: 'radius' | 'polygon';
}

type LatLng = { lat: number; lng: number };

/** Ray-casting point-in-polygon test. Polygon is an array of {lat,lng}. */
export function pointInPolygon(lat: number, lng: number, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Parse a station's geofencePolygon (JSON string or array) into clean points. */
export function parsePolygon(raw: any): LatLng[] {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p: any) => ({ lat: Number(p?.lat ?? p?.latitude), lng: Number(p?.lng ?? p?.longitude) }))
    .filter((p: LatLng) => !isNaN(p.lat) && !isNaN(p.lng));
}

/**
 * Evaluate a punch coordinate against a station's geofence.
 * `station` is expected to carry `latitud`, `longitud`, `geofenceRadius`.
 */
export function evaluateGeofence(
  station: { latitud?: any; longitud?: any; geofenceRadius?: any; geofencePolygon?: any },
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  defaultRadiusM = 100,
): GeofenceResult {
  const radiusM =
    station && station.geofenceRadius != null && !isNaN(Number(station.geofenceRadius))
      ? Number(station.geofenceRadius)
      : defaultRadiusM;

  const lat = latitude == null ? NaN : Number(latitude);
  const lng = longitude == null ? NaN : Number(longitude);

  // Prefer a station polygon (≥3 points) when defined.
  const polygon = parsePolygon(station?.geofencePolygon);
  if (polygon.length >= 3) {
    if (isNaN(lat) || isNaN(lng)) {
      return { distanceM: null, radiusM, outside: false, mode: 'polygon' };
    }
    const inside = pointInPolygon(lat, lng, polygon);
    // Report distance to the polygon centroid for context.
    const cLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
    const cLng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length;
    const distanceM = Math.round(haversineDistance(lat, lng, cLat, cLng));
    return { distanceM, radiusM, outside: !inside, mode: 'polygon' };
  }

  // Fall back to point + radius.
  const stationLat = parseFloat(station?.latitud);
  const stationLng = parseFloat(station?.longitud);
  if (isNaN(stationLat) || isNaN(stationLng) || isNaN(lat) || isNaN(lng)) {
    return { distanceM: null, radiusM, outside: false, mode: 'radius' };
  }
  const distanceM = Math.round(haversineDistance(lat, lng, stationLat, stationLng));
  return { distanceM, radiusM, outside: distanceM > radiusM, mode: 'radius' };
}
