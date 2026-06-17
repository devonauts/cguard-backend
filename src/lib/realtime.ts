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
import { databaseInit } from '../database/databaseConnection';
import AuthService from '../services/auth/authService';
import { registerRadioVoice } from './radioVoice';

export const SOCKET_PATH = '/api/socket.io';

// Roles that receive every tenant notification regardless of an event's
// targetRoles (matches the SEE_ALL set used for recipient resolution).
const SEE_ALL_ROLES = ['admin', 'operationsManager', 'owner'];

let io: IOServer | null = null;

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
  // one worker only reaches clients connected to that same worker.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      pubClient.on('error', (e) => console.error('[realtime] redis pub error:', e?.message || e));
      subClient.on('error', (e) => console.error('[realtime] redis sub error:', e?.message || e));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log('[realtime] socket.io Redis adapter attached (cluster broadcast enabled)');
    } catch (e: any) {
      console.error(
        '[realtime] Redis adapter failed — running single-worker:',
        e?.message || e,
      );
    }
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

      const database = await databaseInit();
      const user: any = await AuthService.findByToken(String(token), { database });
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
      (socket.data as any) = {
        userId: user.id,
        tenantId: effectiveTenantId,
        name: displayName,
        roles,
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
    const { userId, tenantId, roles, seeAll, superadmin } = (socket.data as any) || {};
    if (!tenantId || !userId) return;
    socket.join(`tenant:${tenantId}`);
    socket.join(`tenant:${tenantId}:user:${userId}`);
    (roles || []).forEach((r: string) => socket.join(`tenant:${tenantId}:role:${r}`));
    if (seeAll) socket.join(`tenant:${tenantId}:all`);

    // Platform phone center: superadmins join a shared 'superadmin' room so the
    // Twilio SMS/voice events fan out to every connected superadmin browser.
    if (superadmin) socket.join('superadmin');

    // Live radio "Canal abierto" PTT relay (opt-in per socket via events).
    registerRadioVoice(io as IOServer, socket);
  });

  console.log(`[realtime] socket.io listening on ${SOCKET_PATH}`);
  return io;
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

export default { initRealtime, emitPlatformEvent, emitSuperadminEvent, SOCKET_PATH };
