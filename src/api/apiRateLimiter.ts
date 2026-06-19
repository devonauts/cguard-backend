import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';

/**
 * Shared rate-limit store. The previous in-memory store counted per-worker, so
 * the limit was really (limit × workers), reset on every deploy, and could never
 * hold across a horizontally-scaled fleet. When REDIS_URL is set we use Redis so
 * the limit is fleet-wide. The store is wrapped to FAIL OPEN: if Redis errors we
 * allow the request rather than 500 it — a rate limiter must never take the API
 * down. Falls back to the default in-memory store when REDIS_URL is unset.
 */
let redisClient: any = null;
if (process.env.REDIS_URL) {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (e: any) => console.warn('[rateLimit] redis error:', e?.message || e));
    redisClient.connect().catch((e: any) => {
      console.warn('[rateLimit] redis connect failed — using in-memory store:', e?.message || e);
      redisClient = null;
    });
  } catch (e: any) {
    console.warn('[rateLimit] redis init failed — using in-memory store:', e?.message || e);
    redisClient = null;
  }
}

/** Wrap a store so any backend error degrades to "allow" instead of throwing. */
function failOpen(store: any) {
  return {
    init(options: any) { try { store.init?.(options); } catch { /* ignore */ } },
    async increment(key: string) {
      try { return await store.increment(key); } catch { return { totalHits: 0, resetTime: undefined }; }
    },
    async decrement(key: string) { try { await store.decrement(key); } catch { /* ignore */ } },
    async resetKey(key: string) { try { await store.resetKey(key); } catch { /* ignore */ } },
    async resetAll() { try { await store.resetAll?.(); } catch { /* ignore */ } },
  };
}

// IPs that bypass ALL rate limiting (office / demo machines). Comma-separated in
// RATE_LIMIT_ALLOWLIST. Matched as a substring of req.ip / the X-Forwarded-For
// chain so it tolerates IPv6-mapped forms (e.g. ::ffff:72.191.8.49).
const RATE_LIMIT_ALLOWLIST = (process.env.RATE_LIMIT_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowlisted(req: any): boolean {
  if (!RATE_LIMIT_ALLOWLIST.length) return false;
  const candidates = [req.ip, ...(Array.isArray(req.ips) ? req.ips : [])]
    .filter(Boolean)
    .map(String);
  return RATE_LIMIT_ALLOWLIST.some((allowed) =>
    candidates.some((ip) => ip === allowed || ip.includes(allowed)),
  );
}

export function createRateLimiter({
  max,
  windowMs,
  message,
}: {
  max: number;
  windowMs: number;
  message: string;
}) {
  const store = redisClient
    ? failOpen(new RedisStore({ sendCommand: (...args: string[]) => redisClient.sendCommand(args), prefix: 'rl:' }))
    : undefined; // default in-memory store

  return rateLimit({
    ...(store ? { store: store as any } : {}),
    max,
    windowMs,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      if (req.method === 'OPTIONS') return true;
      if (req.originalUrl.endsWith('/import')) return true;
      if (isAllowlisted(req)) return true; // office/demo IPs never throttled
      return false;
    },
  });
}
