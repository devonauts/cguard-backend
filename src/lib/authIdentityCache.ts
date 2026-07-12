/**
 * Per-user identity cache for the auth hot path.
 *
 * Every authenticated request hydrates the caller via
 * `UserRepository.findById` — a 3–5 round-trip join
 * (user → tenantUser → tenant → settings → assignedClients → assignedPostSites)
 * plus an avatars/files lookup. Under load that join is the dominant DB cost.
 *
 * This caches the *hydrated identity* keyed by user id for a short TTL. It does
 * NOT cache the security-critical, fast-changing fields: the auth path always
 * re-verifies the JWT and re-reads `jwtTokenInvalidBefore` + `activeSessionIds`
 * with a cheap 3-column PK lookup, so forced-logout and single-active-session
 * enforcement stay correct even across the PM2 cluster (where an in-memory bust
 * on one instance wouldn't reach the others).
 *
 * Modeled on RoleRepository's in-memory cache (Map + TTL + size cap + sweep).
 * Kill-switch: env `AUTH_IDENTITY_CACHE_MS` (milliseconds). 0/unset-to-0 disables
 * it entirely; defaults to 20s.
 */

interface Entry {
  // A deep, JSON-safe snapshot of the hydrated user. We clone on read so a
  // request's per-request mutations (clientAccountId, emailVerified, tenant
  // normalization) never leak into the shared cache.
  snapshot: string;
  expires: number;
  lastRead: number;
}

const cache = new Map<string, Entry>();
const IDLE_EVICT_MS = 10 * 60 * 1000; // drop entries unread for 10 min
const MAX_ENTRIES = 20000; // hard cap so a token storm can't grow it unbounded

function ttlMs(): number {
  const raw = process.env.AUTH_IDENTITY_CACHE_MS;
  if (raw === undefined) return 20000; // default 20s
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // explicit disable
  return Math.min(n, 5 * 60 * 1000); // clamp to 5 min
}

export function isAuthIdentityCacheEnabled(): boolean {
  return ttlMs() > 0;
}

/** Returns a fresh deep clone of the cached hydrated user, or null on miss/expiry. */
export function getCachedIdentity(userId: string): any | null {
  if (!userId || !isAuthIdentityCacheEnabled()) return null;
  const hit = cache.get(userId);
  if (!hit) return null;
  const now = Date.now();
  if (now >= hit.expires) {
    cache.delete(userId);
    return null;
  }
  hit.lastRead = now;
  try {
    return JSON.parse(hit.snapshot);
  } catch {
    cache.delete(userId);
    return null;
  }
}

/** Store a JSON-safe deep snapshot of the hydrated user. */
export function setCachedIdentity(userId: string, user: any): void {
  if (!userId || !user || !isAuthIdentityCacheEnabled()) return;
  let snapshot: string;
  try {
    snapshot = JSON.stringify(user);
  } catch {
    return; // non-serializable → skip caching rather than risk a bad entry
  }
  const now = Date.now();
  if (cache.size >= MAX_ENTRIES && !cache.has(userId)) {
    // Evict the oldest-read entry to stay under the cap.
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of cache) {
      if (v.lastRead < oldest) { oldest = v.lastRead; oldestKey = k; }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(userId, { snapshot, expires: now + ttlMs(), lastRead: now });
}

/** Drop a user's cached identity (call after role/profile/membership changes). */
export function invalidateCachedIdentity(userId: string): void {
  if (userId) cache.delete(userId);
}

/** Test/ops helper. */
export function clearAuthIdentityCache(): void {
  cache.clear();
}

// Idle sweep so long-lived entries for logged-off users don't linger.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now >= v.expires || now - v.lastRead > IDLE_EVICT_MS) cache.delete(k);
  }
}, 60 * 1000);
// Don't keep the process alive for the sweep timer.
if (typeof sweep.unref === 'function') sweep.unref();
