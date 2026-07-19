/**
 * Platform Events API
 *
 * Routes:
 *   GET  /api/:tenantId/events/stream   – SSE stream (token via ?token=<jwt>)
 *   GET  /api/:tenantId/events          – List recent events (authed normally)
 *   GET  /api/:tenantId/events/unread   – Count unread events
 *   POST /api/:tenantId/events/:id/read – Mark event as read
 *
 * SSE Authentication:
 *   EventSource in browsers cannot set custom headers. A small middleware
 *   (added in api/index.ts before authMiddleware) promotes the `?token`
 *   query param to the Authorization header so the standard authMiddleware
 *   picks it up transparently.
 */

import { Router } from 'express';
import {
  fetchPendingEventsForUser,
  getRecentEventsForUser,
  markEventRead,
  markAllEventsReadForUser,
  markEventsSent,
  dismissEvent,
  dismissAllForUser,
} from '../lib/platformEventStore';

// SSE poll interval (ms). 5 s is a good balance between latency and DB load.
const POLL_INTERVAL_MS = 5_000;
// How far back to look on initial SSE connect (last 24 h)
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
// Per-instance cap on concurrently open SSE streams. Beyond this we shed load
// with a 503 + Retry-After instead of letting held-open responses and poll work
// grow without bound (cheap insurance on a single box).
const MAX_SSE_CONNECTIONS = Math.max(1, Number(process.env.SSE_MAX_CONNECTIONS) || 3_000);
// Row cap for the shared per-tick fetch (all connected users combined). If a
// backlog exceeds this, per-connection cursors simply pick up the rest next tick.
const SHARED_FETCH_LIMIT = 500;
// Per-connection delivery cap per tick — mirrors the old per-user `LIMIT 50`.
const PER_CONNECTION_BATCH_LIMIT = 50;

// Roles that see every tenant notification regardless of an event's targetRoles.
const SEE_ALL_ROLES = ['admin', 'operationsManager', 'owner'];

/**
 * Resolves the current user's tenant roles and whether they see all events.
 * Superadmins (platform owners) oversee any tenant even without a membership.
 */
function getUserContext(
  currentUser: any,
  tenantId: string,
): { roles: string[]; seeAll: boolean } {
  const tenants = Array.isArray(currentUser?.tenants) ? currentUser.tenants : [];
  const tenantUser = tenants.find(
    (t: any) => t && (t.id === tenantId || t.tenantId === tenantId),
  );
  const raw = tenantUser?.roles || tenantUser?.tenantUser?.roles || [];
  const roles: string[] = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
  const seeAll =
    !!currentUser?.isSuperadmin || roles.some((r) => SEE_ALL_ROLES.includes(r));
  return { roles, seeAll };
}

// ─── Shared SSE poller ────────────────────────────────────────────────────────
//
// Previously EVERY SSE connection ran its own `setInterval(pollAndSend, 5s)`
// hitting the DB — O(connections) queries per tick with no in-flight guard, so
// ticks stacked whenever the pool slowed down (the exact amplification behind
// the 2026-07-07 pool-exhaustion incident). Now ONE module-level interval per
// process serves every connection: each tick runs one batched SELECT over the
// connected tenants + one dismissals lookup, then fans results out in memory
// using the exact same visibility rules the old per-user SQL applied.

interface SseConnection {
  res: any;
  database: any;
  tenantId: string;
  userId: string;
  roles: string[];
  seeAll: boolean;
  /** Cursor: only events with createdAt >= since are delivered (same as before). */
  since: Date;
  send: (eventName: string, data: any) => void;
}

const sseConnections = new Set<SseConnection>();
let sharedPollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;

/** Same DATETIME string form the SQL comparisons used (second granularity). */
function toSqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * In-memory replica of platformEventStore.visibilityClause() — MUST stay in
 * lockstep with it so the shared poller delivers exactly what the old per-user
 * query did:
 *  - seeAll: every broadcast plus own directly-addressed events.
 *  - otherwise: own directly-addressed events, or broadcasts whose targetRoles
 *    is NULL or intersects the user's roles (FIND_IN_SET semantics: exact
 *    comma-separated element match, no trimming).
 */
function eventVisibleTo(ev: any, conn: SseConnection): boolean {
  if (String(ev.tenantId) !== String(conn.tenantId)) return false;
  if (conn.seeAll) {
    return ev.recipientUserId == null || String(ev.recipientUserId) === String(conn.userId);
  }
  if (ev.recipientUserId != null) return String(ev.recipientUserId) === String(conn.userId);
  if (ev.targetRoles == null) return true;
  const parts = String(ev.targetRoles).split(',');
  return conn.roles.some((r) => parts.includes(r));
}

function registerSseConnection(conn: SseConnection): void {
  sseConnections.add(conn);
  if (!sharedPollTimer) {
    sharedPollTimer = setInterval(() => {
      void sharedPollTick();
    }, POLL_INTERVAL_MS);
    if (typeof sharedPollTimer.unref === 'function') sharedPollTimer.unref();
  }
}

function unregisterSseConnection(conn: SseConnection): void {
  sseConnections.delete(conn);
  if (sseConnections.size === 0 && sharedPollTimer) {
    clearInterval(sharedPollTimer);
    sharedPollTimer = null;
  }
}

async function sharedPollTick(): Promise<void> {
  // In-flight guard: if the previous tick is still waiting on the DB, skip this
  // one entirely — a slow pool must never stack additional acquire requests.
  if (pollInFlight || sseConnections.size === 0) return;
  pollInFlight = true;
  try {
    const conns = Array.from(sseConnections);
    // All request-scoped `database` handles point at the same connection pool;
    // any live one works for the shared batched query.
    const database = conns[0].database;
    const tenantIds = Array.from(new Set(conns.map((c) => String(c.tenantId))));
    const minSince = conns.reduce(
      (min, c) => (c.since < min ? c.since : min),
      conns[0].since,
    );

    // ONE batched query per tick (mirrors fetchPendingEventsForUser, minus the
    // per-user visibility/dismissal predicates which are applied in memory).
    const [rows] = await database.sequelize.query(
      `SELECT id, tenantId, eventType, title, body, payload, recipientUserId,
              targetRoles, sourceEntityType, sourceEntityId, deliveryStatus, createdAt
       FROM platform_events
       WHERE tenantId IN (${tenantIds.map(() => '?').join(',')})
         AND deliveryStatus IN ('pending', 'sent')
         AND createdAt >= ?
       ORDER BY createdAt ASC
       LIMIT ${SHARED_FETCH_LIMIT}`,
      { replacements: [...tenantIds, toSqlDateTime(minSince)] },
    );
    const events = rows as any[];
    if (!events.length) return;

    // One batched dismissals lookup replaces the old per-user NOT EXISTS subquery.
    const userIds = Array.from(new Set(conns.map((c) => String(c.userId))));
    const eventIds = events.map((e) => e.id);
    const dismissed = new Set<string>();
    const [dRows] = await database.sequelize.query(
      `SELECT userId, eventId FROM platform_event_dismissals
       WHERE userId IN (${userIds.map(() => '?').join(',')})
         AND eventId IN (${eventIds.map(() => '?').join(',')})`,
      { replacements: [...userIds, ...eventIds] },
    );
    for (const d of dRows as any[]) dismissed.add(`${d.userId}|${d.eventId}`);

    const deliveredIds = new Set<string>();
    for (const conn of conns) {
      if (!sseConnections.has(conn)) continue; // closed while we were querying
      const sinceStr = toSqlDateTime(conn.since);
      let delivered = 0;
      let lastCreatedAt: Date | null = null;
      for (const ev of events) {
        if (delivered >= PER_CONNECTION_BATCH_LIMIT) break;
        const createdAt =
          ev.createdAt instanceof Date ? ev.createdAt : new Date(ev.createdAt);
        // Same second-granularity comparison the old SQL `createdAt >= ?` made.
        if (toSqlDateTime(createdAt) < sinceStr) continue;
        if (dismissed.has(`${conn.userId}|${ev.id}`)) continue;
        if (!eventVisibleTo(ev, conn)) continue;

        conn.send('notification', {
          id: ev.id,
          eventType: ev.eventType,
          title: ev.title,
          body: ev.body,
          payload: ev.payload,
          sourceEntityType: ev.sourceEntityType,
          sourceEntityId: ev.sourceEntityId,
          createdAt: ev.createdAt,
        });
        deliveredIds.add(ev.id);
        delivered += 1;
        lastCreatedAt = createdAt;
      }
      // Advance the cursor to just after the last delivered event — identical to
      // the old per-connection behavior (it never advanced on empty polls).
      if (lastCreatedAt) conn.since = new Date(lastCreatedAt.getTime() + 1);
    }

    if (deliveredIds.size) {
      // Mark them sent in DB (best-effort, non-blocking) — as before.
      markEventsSent(database, Array.from(deliveredIds)).catch(() => {});
    }
  } catch (err) {
    // Log but keep the SSE connections alive on transient DB errors — as before.
    console.error('[SSE] Shared poll error:', (err as any)?.message || err);
  } finally {
    pollInFlight = false;
  }
}

export default (routes: Router) => {
  // ─── SSE Stream ───────────────────────────────────────────────────────────
  routes.get(
    '/:tenantId/events/stream',
    async (req: any, res: any) => {
      const currentUser = req.currentUser;
      const currentTenant = req.currentTenant;
      const database = req.database;

      // Auth check — the middleware promoted ?token to Authorization header
      if (!currentUser) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (!currentTenant) {
        return res.status(403).json({ message: 'Tenant not found' });
      }

      // Per-instance connection cap: shed load with a retryable 503 instead of
      // accumulating unbounded held-open responses.
      if (sseConnections.size >= MAX_SSE_CONNECTIONS) {
        res.setHeader('Retry-After', '30');
        return res
          .status(503)
          .json({ message: 'Too many event-stream connections, retry shortly' });
      }

      const userId = currentUser.id;
      const tenantId = currentTenant.id;
      const { roles, seeAll } = getUserContext(currentUser, tenantId);

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      const sendSSE = (eventName: string, data: any) => {
        try {
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
          if (typeof (res as any).flush === 'function') (res as any).flush();
        } catch {
          // Connection closed, ignore
        }
      };

      // Send initial connected acknowledgment
      sendSSE('connected', { userId, tenantId, roles, seeAll, ts: Date.now() });

      // Start lookback from 24 h ago on first connect, then track latest seen
      let since = new Date(Date.now() - INITIAL_LOOKBACK_MS);

      // Track early disconnects (the backfill below awaits the DB — the client
      // may be gone before we ever register with the shared poller).
      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      // One-off initial backfill on connect (the 24 h history this connection
      // hasn't seen). Runs once per connect; ongoing delivery is handled by the
      // shared per-process poller below.
      try {
        const events = await fetchPendingEventsForUser(
          database,
          tenantId,
          userId,
          roles,
          seeAll,
          since,
        );

        if (events.length > 0) {
          // Advance since cursor to just after the last event we processed
          const lastCreatedAt = events[events.length - 1].createdAt;
          since = new Date(
            typeof lastCreatedAt === 'string'
              ? new Date(lastCreatedAt).getTime() + 1
              : (lastCreatedAt as Date).getTime() + 1,
          );

          // Deliver each event to the client
          for (const ev of events) {
            sendSSE('notification', {
              id: ev.id,
              eventType: ev.eventType,
              title: ev.title,
              body: ev.body,
              payload: ev.payload,
              sourceEntityType: ev.sourceEntityType,
              sourceEntityId: ev.sourceEntityId,
              createdAt: ev.createdAt,
            });
          }

          // Mark them sent in DB (best-effort, non-blocking)
          markEventsSent(
            database,
            events.map((e) => e.id),
          ).catch(() => {});
        }
      } catch (err) {
        // Log but don't kill the SSE connection on transient DB errors
        console.error('[SSE] Poll error:', (err as any)?.message || err);
      }

      // Client vanished during the backfill — never register a dead connection.
      if (closed || res.destroyed || res.writableEnded) {
        return;
      }

      // Join the shared poller (one DB poll per process, not per connection)
      const conn: SseConnection = {
        res,
        database,
        tenantId,
        userId,
        roles,
        seeAll,
        since,
        send: sendSSE,
      };
      registerSseConnection(conn);

      // Keep-alive ping every 30 s to prevent proxy timeouts
      const pingTimer = setInterval(() => {
        try {
          res.write(': ping\n\n');
          if (typeof (res as any).flush === 'function') (res as any).flush();
        } catch {
          // Connection closed
        }
      }, 30_000);

      // Clean up when client disconnects
      req.on('close', () => {
        unregisterSseConnection(conn);
        clearInterval(pingTimer);
      });
    },
  );

  // ─── List recent events (notification panel) ──────────────────────────────
  routes.get(
    '/:tenantId/events',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });
        if (!currentTenant) return res.status(403).json({ message: 'Tenant not found' });

        const { roles, seeAll } = getUserContext(currentUser, currentTenant.id);
        const limit = Math.min(Number(req.query.limit) || 30, 50);

        const events = await getRecentEventsForUser(
          database,
          currentTenant.id,
          currentUser.id,
          roles,
          seeAll,
          limit,
        );

        return res.json({ rows: events });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── Clear all (mark every visible unread event as read) ──────────────────
  routes.post(
    '/:tenantId/events/read-all',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });
        if (!currentTenant) return res.status(403).json({ message: 'Tenant not found' });

        const { roles, seeAll } = getUserContext(currentUser, currentTenant.id);
        await markAllEventsReadForUser(
          database,
          currentTenant.id,
          currentUser.id,
          roles,
          seeAll,
        );

        return res.json({ success: true });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── Dismiss all (per-user clear, leaves shared read state intact) ────────
  routes.delete(
    '/:tenantId/events',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });
        if (!currentTenant) return res.status(403).json({ message: 'Tenant not found' });

        const { roles, seeAll } = getUserContext(currentUser, currentTenant.id);
        await dismissAllForUser(
          database,
          currentTenant.id,
          currentUser.id,
          roles,
          seeAll,
        );

        return res.json({ success: true });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── Dismiss one (per-user clear, leaves shared read state intact) ────────
  routes.delete(
    '/:tenantId/events/:eventId',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });
        if (!currentTenant) return res.status(403).json({ message: 'Tenant not found' });

        await dismissEvent(
          database,
          currentTenant.id,
          currentUser.id,
          req.params.eventId,
        );

        return res.json({ success: true });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── Mark as read ─────────────────────────────────────────────────────────
  routes.post(
    '/:tenantId/events/:eventId/read',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });
        if (!currentTenant) return res.status(403).json({ message: 'Tenant not found' });

        await markEventRead(
          database,
          req.params.eventId,
          currentTenant.id,
          currentUser.id,
        );

        return res.json({ success: true });
      } catch (err) {
        return next(err);
      }
    },
  );
};
