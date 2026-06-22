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
const MIN_INTERVAL_MS = Number(process.env.GEOCODER_MIN_INTERVAL_MS) || 1100; // Nominatim: ≤1 req/s
const CACHE_TTL_MS = Number(process.env.GEOCODER_CACHE_TTL_MS) || 24 * 60 * 60 * 1000; // 24h
const NULL_TTL_MS = 60 * 60 * 1000; // cache "not found" for 1h (allow later retry)

// In-memory cache so the same address never re-hits the upstream within the TTL.
const cache = new Map<string, { pt: GeoPoint | null; at: number }>();

// Serialize + space out upstream calls (Nominatim usage policy: max 1 req/s,
// no parallel bursts). Every real network call goes through this gate.
let gate: Promise<void> = Promise.resolve();
let lastCallAt = 0;
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastCallAt = Date.now(); }
  });
  // Keep the chain alive even if this call rejects.
  gate = run.then(() => undefined, () => undefined);
  return run;
}

export async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const q = (address || '').trim();
  if (q.length < 4) return null;

  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') return null;

  const query =
    COUNTRY_HINT && !q.toLowerCase().includes(COUNTRY_HINT.toLowerCase()) ? `${q}, ${COUNTRY_HINT}` : q;
  const key = query.toLowerCase().replace(/\s+/g, ' ');

  // Cache hit (respecting a shorter TTL for negative results).
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.pt ? CACHE_TTL_MS : NULL_TTL_MS)) return hit.pt;

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;

  const result = await throttle(async (): Promise<GeoPoint | null> => {
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
  });

  cache.set(key, { pt: result, at: Date.now() });
  // Bound the cache so it can't grow unbounded over a long-running process.
  if (cache.size > 5000) { const k = cache.keys().next().value; if (k) cache.delete(k); }
  return result;
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
