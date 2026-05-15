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
  countUnreadEventsForUser,
  markEventRead,
  markEventsSent,
} from '../lib/platformEventStore';

// SSE poll interval (ms). 5 s is a good balance between latency and DB load.
const POLL_INTERVAL_MS = 5_000;
// How far back to look on initial SSE connect (last 24 h)
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

/**
 * Extracts the primary role for the current tenant from req.currentUser.
 */
function getUserRoleForTenant(currentUser: any, tenantId: string): string {
  if (!currentUser || !Array.isArray(currentUser.tenants)) return 'unknown';
  const tenantUser = currentUser.tenants.find(
    (t: any) => t && (t.id === tenantId || t.tenantId === tenantId),
  );
  const roles: string[] =
    tenantUser?.roles ||
    tenantUser?.tenantUser?.roles ||
    [];
  return roles[0] || 'unknown';
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

      const userId = currentUser.id;
      const tenantId = currentTenant.id;
      const userRole = getUserRoleForTenant(currentUser, tenantId);

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
      sendSSE('connected', { userId, tenantId, userRole, ts: Date.now() });

      // Start lookback from 24 h ago on first connect, then track latest seen
      let since = new Date(Date.now() - INITIAL_LOOKBACK_MS);

      const pollAndSend = async () => {
        try {
          const events = await fetchPendingEventsForUser(
            database,
            tenantId,
            userId,
            userRole,
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
      };

      // Run immediately on connect, then on interval
      await pollAndSend();
      const timer = setInterval(pollAndSend, POLL_INTERVAL_MS);

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
        clearInterval(timer);
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

        const userRole = getUserRoleForTenant(currentUser, currentTenant.id);
        const limit = Math.min(Number(req.query.limit) || 30, 50);

        const events = await getRecentEventsForUser(
          database,
          currentTenant.id,
          currentUser.id,
          userRole,
          limit,
        );

        return res.json({ rows: events });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── Unread count ─────────────────────────────────────────────────────────
  routes.get(
    '/:tenantId/events/unread',
    async (req: any, res: any, next: any) => {
      try {
        const currentUser = req.currentUser;
        const currentTenant = req.currentTenant;
        const database = req.database;

        if (!currentUser) return res.status(401).json({ count: 0 });
        if (!currentTenant) return res.status(403).json({ count: 0 });

        const userRole = getUserRoleForTenant(currentUser, currentTenant.id);
        const count = await countUnreadEventsForUser(
          database,
          currentTenant.id,
          currentUser.id,
          userRole,
        );

        return res.json({ count });
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
