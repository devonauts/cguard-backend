import { rateLimit, MemoryStore } from 'express-rate-limit';
import type { Options as RateLimitOptions, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';

/**
 * Shared rate-limit store. The previous in-memory store counted per-worker, so
 * the limit was really (limit × workers), reset on every deploy, and could never
 * hold across a horizontally-scaled fleet. When REDIS_URL is set we use Redis so
 * the limit is fleet-wide.
 *
 * Failure semantics — DEGRADE, don't disable: if Redis errors, times out, or is
 * down, each limiter falls back to its own per-process MemoryStore for the
 * duration of the outage instead of allowing everything through. In degraded
 * mode counters are per-instance, so the effective fleet-wide budget becomes
 * (limit × N instances) and resets if the process restarts — weaker than Redis,
 * but categorically better than NO limiting (the old wrapper failed OPEN and
 * silently disabled rate limiting fleet-wide whenever Redis hiccuped).
 * A circuit breaker trips on the first Redis failure (one loud log, not one per
 * request) and re-probes Redis every 30s so fleet-wide limiting heals
 * automatically; recovery is logged once too.
 *
 * A rate limiter must still never take the API down: if BOTH Redis and the
 * memory fallback somehow throw, that single request is allowed (per-call
 * fail-open, no longer systemic). Falls back to the default in-memory store
 * when REDIS_URL is unset.
 */
let redisClient: any = null;
if (process.env.REDIS_URL) {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    // node-redis reconnects on its own; route errors through the circuit
    // breaker so we log the outage once instead of once per socket error.
    redisClient.on('error', (e: any) => noteRedisFailure(e));
    redisClient.connect().catch((e: any) => noteRedisFailure(e));
  } catch (e: any) {
    console.warn('[rateLimit] redis init failed — using in-memory store:', e?.message || e);
    redisClient = null;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker (shared by every limiter — they all use the same Redis).
// ---------------------------------------------------------------------------

/** How long a Redis command may take before we treat it as down. node-redis
 * QUEUES commands while reconnecting (offline queue), so without this a Redis
 * outage would HANG requests rather than reject them. */
const REDIS_OP_TIMEOUT_MS = 1_000;
/** How often to re-probe Redis while degraded (env-overridable for tests). */
const REDIS_REPROBE_MS = Number(process.env.RATE_LIMIT_REDIS_REPROBE_MS) || 30_000;

let redisDown = false;
let reprobeTimer: NodeJS.Timeout | null = null;

function noteRedisFailure(e: any) {
  if (redisDown) return; // already degraded — stay quiet
  redisDown = true;
  console.error(
    '[rateLimit] Redis unavailable — DEGRADED to per-instance in-memory rate limiting ' +
      '(effective fleet budget is limit × instances until Redis recovers). Cause:',
    e?.message || e,
  );
  scheduleReprobe();
}

function scheduleReprobe() {
  if (reprobeTimer) return;
  reprobeTimer = setInterval(async () => {
    try {
      await withTimeout(redisClient.ping(), 2_000);
      redisDown = false;
      if (reprobeTimer) clearInterval(reprobeTimer);
      reprobeTimer = null;
      console.error('[rateLimit] Redis recovered — fleet-wide rate limiting restored.');
    } catch {
      /* still down — keep probing */
    }
  }, REDIS_REPROBE_MS);
  (reprobeTimer as any).unref?.();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis op timed out after ${ms}ms`)), ms);
    (timer as any).unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Store that proxies to Redis and degrades to a per-limiter MemoryStore while
 * the circuit breaker says Redis is down. Never throws into the request path:
 * if the memory fallback also fails, that single call is allowed.
 */
class DegradingRedisStore {
  prefix: string;
  /** Counts live in Redis (shared) when healthy — declare non-local so the
   * library's double-count validation treats prefixes as authoritative. */
  localKeys = false;
  private redis: RedisStore;
  private memory: MemoryStore;

  constructor(redis: RedisStore, prefix: string) {
    this.redis = redis;
    this.memory = new MemoryStore();
    this.prefix = prefix;
    // RedisStore's constructor eagerly SCRIPT LOADs and stashes the promises on
    // itself; if Redis is down they reject before anything awaits them and
    // crash the process with an unhandled rejection (getScriptSha is never
    // awaited at all under draft-6 headers). Mark them handled — increment()
    // and get() re-await and re-load the scripts themselves when used.
    (redis as any).incrementScriptSha?.catch?.(() => {});
    (redis as any).getScriptSha?.catch?.(() => {});
  }

  init(options: RateLimitOptions): void {
    try { this.redis.init?.(options); } catch (e) { noteRedisFailure(e); }
    try { this.memory.init(options); } catch { /* ignore */ }
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (!redisDown) {
      try {
        return await withTimeout(this.redis.increment(key), REDIS_OP_TIMEOUT_MS);
      } catch (e) {
        noteRedisFailure(e);
      }
    }
    try {
      return await this.memory.increment(key);
    } catch {
      // Last resort: allow THIS request (per-call, not systemic).
      return { totalHits: 0, resetTime: undefined };
    }
  }

  async decrement(key: string): Promise<void> {
    if (!redisDown) {
      try {
        await withTimeout(this.redis.decrement(key), REDIS_OP_TIMEOUT_MS);
        return;
      } catch (e) {
        noteRedisFailure(e);
      }
    }
    try { await this.memory.decrement(key); } catch { /* ignore */ }
  }

  async resetKey(key: string): Promise<void> {
    // Clear both counters so a reset is honored regardless of breaker state.
    if (!redisDown) {
      try { await withTimeout(this.redis.resetKey(key), REDIS_OP_TIMEOUT_MS); } catch (e) { noteRedisFailure(e); }
    }
    try { await this.memory.resetKey(key); } catch { /* ignore */ }
  }

  async resetAll(): Promise<void> {
    try { await this.memory.resetAll(); } catch { /* ignore */ }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (!redisDown) {
      try {
        return await withTimeout(Promise.resolve(this.redis.get(key)), REDIS_OP_TIMEOUT_MS);
      } catch (e) {
        noteRedisFailure(e);
      }
    }
    try { return await this.memory.get(key); } catch { return undefined; }
  }

  shutdown(): void {
    try { this.memory.shutdown(); } catch { /* ignore */ }
  }
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
  name,
  keyByAuth = false,
  skipPaths = [],
}: {
  max: number;
  windowMs: number;
  message: string;
  /**
   * Unique per limiter. Namespaces the Redis keys — without it every limiter
   * shares the same `rl:<ip>` key, so a request passing through two limiters
   * (e.g. the app-wide default + /auth/sign-in) increments the same counter
   * twice (ERR_ERL_DOUBLE_COUNT) and burns the strict limit at double speed.
   * Must be stable across processes/deploys since the Redis store is fleet-wide.
   */
  name: string;
  /**
   * Key authenticated requests by IP + a hash of the Authorization header so
   * every signed-in user/device gets its OWN bucket. Without this, a whole
   * office behind one NAT IP shares a single bucket and normal multi-user CRM
   * usage throttles the entire company (Ecuaseguridad outage, 2026-07-09).
   * Anonymous requests still share the per-IP bucket, so IP-based brute-force
   * limits (sign-in etc.) keep their meaning.
   */
  keyByAuth?: boolean;
  /** Substrings of req.originalUrl this limiter never throttles. */
  skipPaths?: string[];
}) {
  const store = redisClient
    ? new DegradingRedisStore(
        new RedisStore({ sendCommand: (...args: string[]) => redisClient.sendCommand(args), prefix: `rl:${name}:` }),
        `rl:${name}:`,
      )
    : undefined; // default in-memory store

  return rateLimit({
    ...(store ? { store: store as any } : {}),
    max,
    windowMs,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyByAuth
      ? {
          keyGenerator: (req: any) => {
            const auth = String(req.headers?.authorization || '');
            if (!auth) return String(req.ip);
            const crypto = require('crypto');
            const h = crypto.createHash('sha256').update(auth).digest('hex').slice(0, 24);
            return `${req.ip}|${h}`;
          },
          // Custom key includes req.ip verbatim; skip the library's IPv6-subnet
          // keygen validation (we intentionally want per-address behavior).
          validate: false as any,
        }
      : {}),
    // Log every throttle so the superadmin "Accesos" page can surface abuse /
    // brute-force patterns (top rate-limited IPs). Best-effort.
    handler: (req: any, res: any, _next: any, options: any) => {
      try {
        const db = require('../database/models').default();
        const { logSecurityEvent } = require('../services/auth/securityAudit');
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
        logSecurityEvent(db, {
          event: 'rate_limited',
          outcome: 'failure',
          email: req.body?.email || req.body?.data?.email || null,
          ip,
          userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
          detail: String(req.originalUrl || '').slice(0, 200),
        }).catch(() => {});
      } catch { /* best-effort */ }
      res.status(options.statusCode).send(options.message);
    },
    skip: (req) => {
      if (req.method === 'OPTIONS') return true;
      if (req.originalUrl.endsWith('/import')) return true;
      if (skipPaths.some((p) => req.originalUrl.includes(p))) return true;
      if (isAllowlisted(req)) return true; // office/demo IPs never throttled
      return false;
    },
  });
}
