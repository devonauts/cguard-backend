/**
 * Minimal forward geocoder (address → lat/lng) using OpenStreetMap Nominatim.
 * No API key required. Best-effort: returns null on any failure/timeout. Respect
 * Nominatim's usage policy — identify via User-Agent, keep volume low; bulk
 * backfill callers MUST throttle (~1 req/s). Override the endpoint with a keyed
 * provider via env if higher volume is needed.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const NOMINATIM_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
const COUNTRY_HINT = process.env.GEOCODER_COUNTRY || ''; // e.g. "Ecuador"
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'CGuardPro/1.0 (scheduling-proximity)';

export async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const q = (address || '').trim();
  if (q.length < 4) return null;

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') return null;

  const query =
    COUNTRY_HINT && !q.toLowerCase().includes(COUNTRY_HINT.toLowerCase()) ? `${q}, ${COUNTRY_HINT}` : q;
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;

  const AbortCtl: any = (globalThis as any).AbortController;
  const controller = AbortCtl ? new AbortCtl() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) return null;
    const data: any = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { latitude: lat, longitude: lon };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Geocode a guard's address and persist lat/lng. Best-effort — never throws.
 * Returns true when coordinates were written.
 */
export async function geocodeGuardIfNeeded(
  db: any,
  tenantId: string,
  securityGuardId: string,
  address: string | null | undefined,
): Promise<boolean> {
  if (!address || !securityGuardId) return false;
  try {
    const pt = await geocodeAddress(address);
    if (!pt) return false;
    await db.securityGuard.update(
      { latitude: pt.latitude, longitude: pt.longitude },
      { where: { id: securityGuardId, tenantId } },
    );
    return true;
  } catch {
    return false;
  }
}
