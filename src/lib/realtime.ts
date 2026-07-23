/**
 * Realtime (websocket) transport — socket.io.
 *
 * Pushes platform events to connected browsers instantly, replacing the SSE
 * poll for live delivery (events are still persisted in `platform_events` for
 * history/unread). Under PM2 cluster mode a single browser is connected to one
 * worker, so cross-worker broadcast requires a shared Redis adapter; when
 * `REDIS_URL` is set we attach it, otherwise we fall back to single-worker mode
 * (fine for local dev / a single instance).
 *
 * Transport is forced to websocket-only so the HTTP long-poll handshake can't
 * bounce between cluster workers (which would otherwise need sticky sessions).
 *
 * The socket is served under `/api/socket.io` so it travels through the same
 * reverse-proxy / dev rule that already routes `/api` to this backend.
 */

import { Server as IOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { createHash } from 'crypto';
import { databaseInit } from '../database/databaseConnection';
import AuthService from '../services/auth/authService';

export const SOCKET_PATH = '/api/socket.io';

// Roles that receive every tenant notification regardless of an event's
// targetRoles (matches the SEE_ALL set used for recipient resolution).
const SEE_ALL_ROLES = ['admin', 'operationsManager', 'owner'];

// Roles whose sessions may render the live supervision layers (the CRM
// Control Center / operations map). Mirrors the CRM's /dashboard role set.
// Deliberately excludes securityGuard and customer so high-frequency position
// streams (supervisor GPS pings) never fan out to every guard phone.
const SUPERVISION_ROLES = [
  'admin',
  'operationsManager',
  'securitySupervisor',
  'hrManager',
  'clientAccountManager',
  'dispatcher',
  'administrativeSupervisor',
  'administrativeAssistant',
  'secretary',
];

let io: IOServer | null = null;
let adapterAttached = false;

/** PM2 cluster mode sets NODE_APP_INSTANCE on every worker. */
function isPm2Cluster(): boolean {
  const v = process.env.NODE_APP_INSTANCE;
  return v !== undefined && v !== '';
}

// ─── Handshake auth cache ─────────────────────────────────────────────────────
//
// AuthService.findByToken is expensive (jwt.verify + a multi-join user hydrate,
// ~4-5 queries). Every socket connect — including the reconnect stampede after
// a PM2 reload drops all clients — used to pay it against the shared 25-conn
// pool. A short TTL cache keyed by a hash of the token collapses the storm to
// at most one resolve per token per TTL; 30 s of identity staleness is fine for
// the socket handshake (REST auth stays uncached). Failures are never cached.
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_MAX_ENTRIES = 5_000;
const authCache = new Map<string, { user: any; expiresAt: number }>();
const authInFlight = new Map<string, Promise<any>>();

function tokenCacheKey(token: string): string {
  // Never hold raw JWTs in memory — key by digest.
  return createHash('sha256').update(token).digest('hex');
}

/** Resolve the user for a handshake token, via the TTL cache. */
async function resolveSocketUser(token: string): Promise<any> {
  const key = tokenCacheKey(token);
  const hit = authCache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.user;
    authCache.delete(key);
  }

  // Collapse concurrent handshakes with the same token onto one DB resolve
  // (multiple tabs / retrying app all reconnect with the same JWT).
  const inFlight = authInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const database = await databaseInit();
    const user: any = await AuthService.findByToken(String(token), { database });
    if (user && user.id) {
      // Size cap: evict oldest entries (Map preserves insertion order).
      while (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
        const oldest = authCache.keys().next().value;
        if (oldest === undefined) break;
        authCache.delete(oldest);
      }
      authCache.set(key, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    }
    return user;
  })();
  authInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    authInFlight.delete(key);
  }
}

/** All roles a user holds for a given tenant (from the user.tenants membership array). */
function rolesForTenant(user: any, tenantId: string): string[] {
  if (!user || !Array.isArray(user.tenants)) return [];
  const tu = user.tenants.find(
    (t: any) =>
      t && (t.id === tenantId || t.tenantId === tenantId || (t.tenant && t.tenant.id === tenantId)),
  );
  const roles = tu?.roles || tu?.tenantUser?.roles || [];
  return Array.isArray(roles)
    ? roles
    : String(roles || '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
}

function belongsToTenant(user: any, tenantId: string): boolean {
  if (!user || !Array.isArray(user.tenants)) return false;
  return user.tenants.some(
    (t: any) =>
      t && (t.id === tenantId || t.tenantId === tenantId || (t.tenant && t.tenant.id === tenantId)),
  );
}

/**
 * Joins a connected socket to all its rooms based on the identity stashed in
 * socket.data by the handshake middleware. Used at connection time AND to
 * re-join sockets after a late Redis-adapter attach (swapping the adapter
 * resets room state, so sockets that connected while degraded must re-join).
 */
function joinSocketRooms(socket: any): void {
  const { userId, tenantId, roles, seeAll, superadmin, clientAccountId } =
    (socket.data as any) || {};
  if (!tenantId || !userId) return;
  socket.join(`tenant:${tenantId}`);
  socket.join(`tenant:${tenantId}:user:${userId}`);
  (roles || []).forEach((r: string) => socket.join(`tenant:${tenantId}:role:${r}`));
  if (seeAll) socket.join(`tenant:${tenantId}:all`);

  // Narrow room for high-frequency live-map streams (e.g. supervisor GPS
  // pings' `location:update`): only supervision-capable sessions join it, so
  // those emits don't reach every guard phone in the tenant.
  if (seeAll || (roles || []).some((r: string) => SUPERVISION_ROLES.includes(r))) {
    socket.join(`tenant:${tenantId}:supervision`);
  }

  // Mi Seguridad customer connections join a per-clientAccount room so the
  // backend can push live chat messages / coverage / status to a specific
  // customer without touching the guard/CRM role rooms. Additive + isolated.
  if (clientAccountId) socket.join(`tenant:${tenantId}:client:${clientAccountId}`);

  // Platform phone center: superadmins join a shared 'superadmin' room so the
  // Twilio SMS/voice events fan out to every connected superadmin browser.
  if (superadmin) socket.join('superadmin');
}

/**
 * One attempt to connect the Redis pub/sub pair and attach the cluster adapter.
 * On success, re-joins any sockets that connected while we were degraded (the
 * adapter swap resets room membership, including each socket's own sid room).
 */
async function tryAttachRedisAdapter(server: IOServer, redisUrl: string): Promise<boolean> {
  let pubClient: any = null;
  let subClient: any = null;
  try {
    pubClient = createClient({ url: redisUrl });
    subClient = pubClient.duplicate();
    pubClient.on('error', (e: any) => console.error('[realtime] redis pub error:', e?.message || e));
    subClient.on('error', (e: any) => console.error('[realtime] redis sub error:', e?.message || e));
    await Promise.all([pubClient.connect(), subClient.connect()]);
    server.adapter(createAdapter(pubClient, subClient));
    adapterAttached = true;

    // Sockets already connected joined their rooms in the OLD (in-memory)
    // adapter; restore their membership in the new one.
    for (const socket of server.of('/').sockets.values()) {
      try {
        socket.join(socket.id);
        joinSocketRooms(socket);
      } catch { /* socket may be mid-disconnect */ }
    }
    console.log('[realtime] socket.io Redis adapter attached (cluster broadcast enabled)');
    return true;
  } catch (e: any) {
    console.error('[realtime] Redis adapter connect failed:', e?.message || e);
    try { pubClient?.disconnect?.().catch?.(() => {}); } catch { /* already closed */ }
    try { subClient?.disconnect?.().catch?.(() => {}); } catch { /* already closed */ }
    return false;
  }
}

/**
 * Retries the adapter attach with capped exponential backoff (5s → 5min),
 * forever, instead of the old behavior of giving up after one boot-time
 * failure and silently running single-worker for the life of the process.
 */
function scheduleAdapterRetry(server: IOServer, redisUrl: string, attempt: number): void {
  const delayMs = Math.min(5_000 * 2 ** Math.min(attempt - 1, 6), 300_000);
  console.error(
    `[realtime] cross-instance broadcast DEGRADED — Redis adapter retry #${attempt} in ${Math.round(delayMs / 1_000)}s`,
  );
  const timer = setTimeout(async () => {
    if (adapterAttached) return;
    const attached = await tryAttachRedisAdapter(server, redisUrl);
    if (!attached) scheduleAdapterRetry(server, redisUrl, attempt + 1);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Snapshot of realtime cluster-delivery health for the /api/health endpoint.
 * `degraded` is true when we're on a PM2 cluster worker WITHOUT a working
 * Redis adapter — i.e. cross-instance emits are being lost.
 */
export function getRealtimeHealth(): {
  initialized: boolean;
  clusterAdapter: 'attached' | 'retrying' | 'not_configured';
  degraded: boolean;
} {
  return {
    initialized: !!io,
    clusterAdapter: adapterAttached
      ? 'attached'
      : process.env.REDIS_URL
        ? 'retrying'
        : 'not_configured',
    degraded: !!io && !adapterAttached && isPm2Cluster(),
  };
}

/**
 * Initialize the socket.io server on the given HTTP server. Safe to call once
 * at startup; subsequent calls return the existing instance.
 */
export async function initRealtime(httpServer: any): Promise<IOServer> {
  if (io) return io;

  io = new IOServer(httpServer, {
    path: SOCKET_PATH,
    cors: { origin: true, credentials: true },
    transports: ['websocket'],
  });

  // Cluster-wide broadcast via Redis (optional). Without it, an event emitted on
  // one worker only reaches clients connected to that same worker. A transient
  // Redis failure at boot no longer abandons the adapter forever — we retry with
  // capped exponential backoff until it attaches.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const attached = await tryAttachRedisAdapter(io, redisUrl);
    if (!attached) scheduleAdapterRetry(io, redisUrl, 1);
  } else if (isPm2Cluster()) {
    // Under PM2 cluster mode a missing REDIS_URL means cross-instance emits
    // (panic alerts, alarm pushes, live map, client chat) silently reach ZERO
    // sockets on the other worker(s). Make that unmissable and repeat hourly.
    const alertMissingRedis = () =>
      console.error(
        '[realtime] *** REDIS_URL NOT SET UNDER PM2 CLUSTER *** socket.io is running ' +
          'single-worker: realtime emits (incl. panic alerts) only reach sockets ' +
          'connected to THIS instance. Set REDIS_URL and reload to restore ' +
          'cross-instance delivery.',
      );
    alertMissingRedis();
    const missingRedisTimer = setInterval(alertMissingRedis, 60 * 60 * 1_000);
    if (typeof missingRedisTimer.unref === 'function') missingRedisTimer.unref();
  } else {
    console.warn(
      '[realtime] REDIS_URL not set — socket.io running single-worker (no cross-cluster broadcast)',
    );
  }

  // Handshake auth: verify JWT, confirm tenant membership, stash identity.
  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth as any)?.token || (socket.handshake.query as any)?.token;
      const tenantId =
        (socket.handshake.auth as any)?.tenantId || (socket.handshake.query as any)?.tenantId;
      if (!token || !tenantId) return next(new Error('unauthorized'));

      // Cached identity resolve (30 s TTL) — collapses the post-reload
      // reconnect stampede to one findByToken per distinct token per TTL.
      const user: any = await resolveSocketUser(String(token));
      if (!user || !user.id) return next(new Error('unauthorized'));
      const superadmin = !!user.isSuperadmin;

      // The platform phone center connects as a superadmin without a real
      // tenant — a sentinel tenantId 'platform' is allowed for superadmins.
      const effectiveTenantId = tenantId ? String(tenantId) : superadmin ? 'platform' : '';
      if (!effectiveTenantId) return next(new Error('unauthorized'));

      // Superadmins can oversee any tenant even without a membership row, and
      // may connect with no tenant context at all (the 'platform' sentinel).
      if (
        !superadmin &&
        effectiveTenantId !== 'platform' &&
        !belongsToTenant(user, effectiveTenantId)
      ) {
        return next(new Error('forbidden'));
      }

      const roles = rolesForTenant(user, effectiveTenantId);
      const displayName =
        user.fullName ||
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.email ||
        'Usuario';
      // Customer (Mi Seguridad client app) connections: the customer JWT carries a
      // clientAccountId (attached by AuthService.findByToken). We stash it so the
      // connection can join a per-clientAccount room for live chat/status pushes.
      // Also honor an explicit handshake clientAccountId, but only if it matches the
      // token's (never trust a body-supplied id to widen scope).
      const tokenClientAccountId = (user as any)?.clientAccountId
        ? String((user as any).clientAccountId)
        : null;
      (socket.data as any) = {
        userId: user.id,
        tenantId: effectiveTenantId,
        name: displayName,
        roles,
        clientAccountId: tokenClientAccountId,
        superadmin,
        // Admins / managers / superadmins receive every tenant notification,
        // regardless of an event's targetRoles.
        seeAll: superadmin || roles.some((r) => SEE_ALL_ROLES.includes(r)),
      };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    joinSocketRooms(socket);
    registerCoBrowse(io, socket);
  });

  console.log(`[realtime] socket.io listening on ${SOCKET_PATH}`);
  return io;
}

// ─── Co-browse: superadmin live session viewing (rrweb relay) ────────────────
// A superadmin WATCHES a tenant user's live CRM session: the tenant's browser
// streams rrweb events (DOM + cursor/clicks/scroll) which the server relays to
// the watching superadmin(s). Rooms: `cobrowse:<tenantId>:<userId>` hold the
// watchers; the target CRM sits in its normal `tenant:<id>:user:<uid>` room.
// Security: only sockets whose handshake resolved `superadmin` may watch or
// receive a stream, and a tenant socket can only stream ITS OWN session (the
// room is derived from its own socket.data, never from client input).
function registerCoBrowse(io: any, socket: any): void {
  const sd = () => (socket.data as any) || {};
  const roomOf = (tenantId: string, userId: string) => `cobrowse:${tenantId}:${userId}`;
  const stopTarget = (tenantId: string, userId: string) =>
    io.to(`tenant:${tenantId}:user:${userId}`).emit('cobrowse:stop', {});

  // CLUSTER-SAFE watcher count: the Redis adapter fans out EMITS across the 2
  // PM2 instances, but `adapter.rooms` is LOCAL to each instance — so a room
  // membership check on the emitter's instance can't see a watcher on the other
  // instance. fetchSockets() aggregates across the whole cluster.
  const watchersInCluster = async (room: string): Promise<number> => {
    try { return (await io.in(room).fetchSockets()).length; } catch { return 0; }
  };

  // Superadmin: who is online (CRM) for a tenant, so they can pick a session.
  socket.on('cobrowse:online', async (payload: any, cb: any) => {
    try {
      if (!sd().superadmin) return typeof cb === 'function' && cb({ ok: false, error: 'forbidden' });
      const tenantId = String(payload?.tenantId || '');
      if (!tenantId) return typeof cb === 'function' && cb({ ok: false, error: 'bad_request' });
      const seen = new Map<string, any>();
      // Cross-instance: fetchSockets() returns RemoteSockets from every worker,
      // each carrying its socket.data (set at handshake).
      const sockets = await io.in(`tenant:${tenantId}`).fetchSockets();
      for (const s of sockets) {
        const d = (s.data as any) || {};
        if (d.userId && !d.superadmin) {
          seen.set(String(d.userId), { userId: String(d.userId), name: d.name || null, roles: d.roles || [] });
        }
      }
      typeof cb === 'function' && cb({ ok: true, users: Array.from(seen.values()) });
    } catch {
      typeof cb === 'function' && cb({ ok: false, error: 'error' });
    }
  });

  // Superadmin: start watching a specific user's session.
  socket.on('cobrowse:watch', async (payload: any, cb: any) => {
    try {
      if (!sd().superadmin) return typeof cb === 'function' && cb({ ok: false, error: 'forbidden' });
      const tenantId = String(payload?.tenantId || '');
      const userId = String(payload?.userId || '');
      if (!tenantId || !userId) return typeof cb === 'function' && cb({ ok: false, error: 'bad_request' });
      socket.join(roomOf(tenantId, userId));
      const targetRoom = `tenant:${tenantId}:user:${userId}`;
      const targets = await watchersInCluster(targetRoom);
      console.log(`[cobrowse] WATCH by=${sd().userId} tenant=${tenantId} user=${userId} targetSockets=${targets}`);
      // Tell the target CRM to (re)start recording + show the consent banner.
      // `fresh:true` asks it to send a full snapshot so a late watcher isn't blank.
      io.to(targetRoom).emit('cobrowse:start', {
        by: sd().name || sd().userId || 'Soporte',
        fresh: true,
      });
      typeof cb === 'function' && cb({ ok: true, targets });
    } catch (e: any) {
      console.error('[cobrowse] WATCH error', e?.message || e);
      typeof cb === 'function' && cb({ ok: false, error: 'error' });
    }
  });

  // CRM → server ACK: lets us trace the flow server-side without the tenant's
  // browser console. Logs whether the CRM received the start signal + recorded.
  socket.on('cobrowse:ack', (payload: any) => {
    console.log(`[cobrowse] ACK stage=${payload?.stage} tenant=${sd().tenantId} user=${sd().userId}`);
  });

  // Superadmin: stop watching (or the tab closes → 'disconnecting' below).
  socket.on('cobrowse:stop', async (payload: any) => {
    if (!sd().superadmin) return;
    const tenantId = String(payload?.tenantId || '');
    const userId = String(payload?.userId || '');
    if (!tenantId || !userId) return;
    const room = roomOf(tenantId, userId);
    socket.leave(room);
    // Only tell the CRM to stop when NO watcher remains anywhere in the cluster.
    if ((await watchersInCluster(room)) === 0) stopTarget(tenantId, userId);
  });

  // Tenant CRM: relay a batch of rrweb events for ITS OWN session. The room is
  // derived from THIS socket's data (never client input), so a tenant can only
  // ever broadcast its own session. The Redis adapter delivers to watchers on
  // any instance — no local membership guard (that was cluster-broken and made
  // the viewer hang on "conectando" whenever emitter and watcher split workers).
  let _evtLogged = 0;
  socket.on('cobrowse:event', (payload: any) => {
    const tenantId = sd().tenantId;
    const userId = sd().userId;
    if (!tenantId || !userId || sd().superadmin) return;
    if (_evtLogged < 3) {
      _evtLogged++;
      console.log(`[cobrowse] EVENT tenant=${tenantId} user=${userId} events=${payload?.events?.length ?? '?'}`);
    }
    socket.to(roomOf(String(tenantId), String(userId))).emit('cobrowse:stream', payload);
  });

  // If a watcher's socket drops and it was the last one anywhere, stop the target.
  socket.on('disconnecting', async () => {
    if (!sd().superadmin) return;
    for (const room of socket.rooms) {
      if (typeof room === 'string' && room.startsWith('cobrowse:')) {
        const parts = room.split(':'); // cobrowse:<tenantId>:<userId>
        // This socket is still counted until 'disconnect' completes, so <=1 = last.
        if (parts.length === 3 && (await watchersInCluster(room)) <= 1) {
          stopTarget(parts[1], parts[2]);
        }
      }
    }
  });
}

function safeParse(value: any): any {
  if (value == null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Emit a stored platform event to the browsers entitled to it. Mirrors the SSE
 * targeting in api/events.ts: a specific recipient → that user's room; otherwise
 * fan out to the targetRoles role rooms (or the whole tenant when unscoped).
 * No-op if the socket server isn't initialized.
 */
export function emitPlatformEvent(event: {
  id: string;
  tenantId: string;
  eventType: string;
  title: string;
  body: string;
  payload?: any;
  recipientUserId?: string | null;
  targetRoles?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  createdAt?: Date | string;
}): void {
  if (!io) return;
  try {
    const payload = {
      id: event.id,
      eventType: event.eventType,
      title: event.title,
      body: event.body,
      payload: safeParse(event.payload),
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: event.sourceEntityId,
      createdAt: event.createdAt || new Date().toISOString(),
    };
    const t = event.tenantId;

    if (event.recipientUserId) {
      io.to(`tenant:${t}:user:${event.recipientUserId}`).emit('notification', payload);
      return;
    }
    // Build the union of target rooms and emit ONCE. socket.io delivers a single
    // copy to a socket even if it belongs to several of these rooms — emitting to
    // each room in a separate io.to().emit() call (as before) sent 2-3 duplicate
    // copies to recipients who sit in `:all` AND hold multiple target roles.
    // The "see all" room is always included so admins / managers / superadmins
    // receive role- and tenant-targeted events (a superadmin with no tenant role
    // isn't in any role room otherwise).
    const rooms = [`tenant:${t}:all`];
    if (event.targetRoles) {
      String(event.targetRoles)
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
        .forEach((r) => rooms.push(`tenant:${t}:role:${r}`));
    } else {
      rooms.push(`tenant:${t}`);
    }
    io.to(rooms).emit('notification', payload);
  } catch (e: any) {
    console.error('[realtime] emit failed:', e?.message || e);
  }
}

/**
 * Emit a platform-scoped event to all connected superadmin browsers (the
 * 'superadmin' room). Used by the Twilio phone center to push live SMS and
 * voice-call updates. No-op if the socket server isn't initialized.
 *
 * Event names (see backend Twilio services):
 *   'twilio:sms:inbound'   { conversationId, message }
 *   'twilio:sms:status'    { twilioSid, status }
 *   'twilio:sms:outbound'  { conversationId, message }
 *   'twilio:call:incoming' { callSid, from }
 *   'twilio:call:status'   { callSid, status, durationSec? }
 */
export function emitSuperadminEvent(event: string, payload: any): void {
  if (!io) return;
  try {
    io.to('superadmin').emit(event, payload);
  } catch (e: any) {
    console.error('[realtime] superadmin emit failed:', e?.message || e);
  }
}

/**
 * Emit an arbitrary event to EVERY connected socket of a tenant (the
 * `tenant:<id>` room every member joins). Used for real-time live-map position
 * streams (`location:update`) that aren't notifications and shouldn't persist.
 * No-op if the socket server isn't initialized. Cluster-safe via the Redis
 * adapter (delivered to whichever worker holds the client).
 */
export function emitToTenant(tenantId: string, event: string, payload: any): void {
  if (!io || !tenantId) return;
  try {
    io.to(`tenant:${tenantId}`).emit(event, payload);
  } catch (e: any) {
    console.error('[realtime] tenant emit failed:', e?.message || e);
  }
}

/**
 * Emit a high-frequency live-map event (e.g. a supervisor GPS ping's
 * `location:update`) ONLY to the tenant's supervision room — sessions whose
 * roles can render the Control Center map (see SUPERVISION_ROLES +
 * joinSocketRooms). Unlike emitToTenant, this never reaches guard phones, so
 * per-ping fan-out stays proportional to open dashboards, not tenant size.
 * No-op if the socket server isn't initialized. Never throws.
 */
export function emitToSupervision(tenantId: string, event: string, payload: any): void {
  if (!io || !tenantId) return;
  try {
    io.to(`tenant:${tenantId}:supervision`).emit(event, payload);
  } catch (e: any) {
    console.error('[realtime] supervision emit failed:', e?.message || e);
  }
}

/**
 * Emit a real-time event to a single Mi Seguridad customer (every socket that
 * authenticated with that clientAccount's JWT joined `tenant:<id>:client:<caId>`).
 * Used to replace the client app's chat/status polling: a `message:new`,
 * `coverage`, or `status` event lands instantly in the customer's app.
 *
 * Event names + payloads emitted to this room (the client app listens for these):
 *   'message:new' { conversationId, message }
 *   'coverage'    { ...arbitrary coverage payload }
 *   'status'      { ...arbitrary status payload }
 *
 * No-op if the socket server isn't initialized or ids are missing. Never throws.
 */
export function emitToClientAccount(
  tenantId: string,
  clientAccountId: string,
  event: string,
  payload: any,
): void {
  if (!io || !tenantId || !clientAccountId) return;
  try {
    io.to(`tenant:${tenantId}:client:${clientAccountId}`).emit(event, payload);
  } catch (e: any) {
    console.error('[realtime] client emit failed:', e?.message || e);
  }
}

/**
 * Single active session: tell a user's OTHER devices on `channel` that their
 * session was just superseded by a new sign-in. Emitted to the per-user room
 * in every tenant the user belongs to (sockets joined `tenant:<t>:user:<id>`
 * at auth time). Clients that receive it re-check /auth/me — the superseded
 * token gets 401 auth.sessionSuperseded — and land on the login screen
 * immediately instead of on their next request. Payload carries the NEW sid
 * so the device that just signed in can ignore its own event. Never throws.
 */
export function emitSessionSuperseded(
  tenantIds: string[],
  userId: string,
  channel: string,
  newSid: string,
): void {
  if (!io || !userId) return;
  try {
    for (const t of tenantIds || []) {
      if (!t) continue;
      io.to(`tenant:${t}:user:${userId}`).emit('session:superseded', { channel, sid: newSid });
    }
  } catch (e: any) {
    console.error('[realtime] session emit failed:', e?.message || e);
  }
}

export default { initRealtime, emitPlatformEvent, emitSuperadminEvent, emitToTenant, emitToSupervision, emitToClientAccount, emitSessionSuperseded, getRealtimeHealth, SOCKET_PATH };
