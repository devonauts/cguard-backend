import { v4 as uuidv4 } from 'uuid';
import { emitPlatformEvent } from './realtime';

export interface PlatformEvent {
  id: string;
  tenantId: string;
  eventType: string;
  title: string;
  body: string;
  payload?: any;
  recipientUserId?: string | null;
  targetRoles?: string | null;
  sourceEntityType?: string;
  sourceEntityId?: string;
  deliveryStatus: 'pending' | 'sent' | 'read';
  createdAt: Date | string;
}

/**
 * Ensures the platform_events table exists.
 * Call once at server startup with the initialized database object.
 */
export async function ensurePlatformEventsTable(database: any): Promise<void> {
  await database.sequelize.query(`
    CREATE TABLE IF NOT EXISTS platform_events (
      id          VARCHAR(36)  NOT NULL,
      tenantId    VARCHAR(36)  NOT NULL,
      eventType   VARCHAR(100) NOT NULL,
      title       VARCHAR(255) NOT NULL,
      body        TEXT,
      payload     JSON,
      recipientUserId VARCHAR(36) DEFAULT NULL,
      targetRoles VARCHAR(500) DEFAULT NULL,
      sourceEntityType VARCHAR(100) DEFAULT NULL,
      sourceEntityId   VARCHAR(36)  DEFAULT NULL,
      deliveryStatus   VARCHAR(20)  NOT NULL DEFAULT 'pending',
      createdAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_pe_tenant_recipient (tenantId, recipientUserId),
      INDEX idx_pe_delivery (deliveryStatus),
      INDEX idx_pe_created (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/**
 * Stores a new platform event in the database.
 * Returns the generated event id.
 */
export async function storePlatformEvent(
  database: any,
  event: {
    tenantId: string;
    eventType: string;
    title: string;
    body: string;
    payload?: any;
    recipientUserId?: string | null;
    targetRoles?: string | null;
    sourceEntityType?: string;
    sourceEntityId?: string;
  },
): Promise<string> {
  const id = uuidv4();
  await database.sequelize.query(
    `INSERT INTO platform_events
      (id, tenantId, eventType, title, body, payload, recipientUserId, targetRoles, sourceEntityType, sourceEntityId, deliveryStatus, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    {
      replacements: [
        id,
        event.tenantId,
        event.eventType,
        event.title,
        event.body || '',
        event.payload ? JSON.stringify(event.payload) : null,
        event.recipientUserId || null,
        event.targetRoles || null,
        event.sourceEntityType || null,
        event.sourceEntityId || null,
      ],
    },
  );

  // Push instantly over websockets (best-effort; persistence above is the
  // source of truth for history/unread and never depends on this).
  emitPlatformEvent({ id, createdAt: new Date().toISOString(), ...event });

  return id;
}

/**
 * Fetches events that are still pending/sent for a given user.
 * Matches events either directly addressed to the user OR broadcast to their role.
 * `since` limits the lookback window (e.g., last 24 h on initial connect).
 */
export async function fetchPendingEventsForUser(
  database: any,
  tenantId: string,
  userId: string,
  userRole: string,
  since: Date,
): Promise<PlatformEvent[]> {
  const sinceStr = since.toISOString().slice(0, 19).replace('T', ' ');
  const [rows] = await database.sequelize.query(
    `SELECT id, tenantId, eventType, title, body, payload, recipientUserId,
            targetRoles, sourceEntityType, sourceEntityId, deliveryStatus, createdAt
     FROM platform_events
     WHERE tenantId = ?
       AND deliveryStatus IN ('pending', 'sent')
       AND (
         recipientUserId = ?
         OR (
           recipientUserId IS NULL
           AND (targetRoles IS NULL OR FIND_IN_SET(?, targetRoles) > 0)
         )
       )
       AND createdAt >= ?
     ORDER BY createdAt ASC
     LIMIT 50`,
    { replacements: [tenantId, userId, userRole, sinceStr] },
  );
  return rows as PlatformEvent[];
}

/**
 * Marks a batch of events as 'sent' (delivered to the browser via SSE).
 */
export async function markEventsSent(database: any, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  await database.sequelize.query(
    `UPDATE platform_events
     SET deliveryStatus = 'sent'
     WHERE id IN (${placeholders}) AND deliveryStatus = 'pending'`,
    { replacements: ids },
  );
}

/**
 * Marks a single event as 'read' (user dismissed it in the UI).
 * Only updates events the user is entitled to see.
 */
export async function markEventRead(
  database: any,
  id: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  await database.sequelize.query(
    `UPDATE platform_events
     SET deliveryStatus = 'read'
     WHERE id = ? AND tenantId = ?
       AND (recipientUserId IS NULL OR recipientUserId = ?)`,
    { replacements: [id, tenantId, userId] },
  );
}

/**
 * Marks ALL of a user's currently-unread (pending/sent) events as read — the
 * "clear all" action in the notification panel. Same visibility scope as the
 * list/unread-count queries.
 */
export async function markAllEventsReadForUser(
  database: any,
  tenantId: string,
  userId: string,
  userRole: string,
): Promise<void> {
  await database.sequelize.query(
    `UPDATE platform_events
     SET deliveryStatus = 'read'
     WHERE tenantId = ?
       AND deliveryStatus IN ('pending', 'sent')
       AND (
         recipientUserId = ?
         OR (
           recipientUserId IS NULL
           AND (targetRoles IS NULL OR FIND_IN_SET(?, targetRoles) > 0)
         )
       )
       AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    { replacements: [tenantId, userId, userRole] },
  );
}

/**
 * Returns up to `limit` recent events for a user (for the notification panel list).
 */
export async function getRecentEventsForUser(
  database: any,
  tenantId: string,
  userId: string,
  userRole: string,
  limit = 30,
): Promise<PlatformEvent[]> {
  const [rows] = await database.sequelize.query(
    `SELECT id, tenantId, eventType, title, body, payload, recipientUserId,
            targetRoles, sourceEntityType, sourceEntityId, deliveryStatus, createdAt
     FROM platform_events
     WHERE tenantId = ?
       AND (
         recipientUserId = ?
         OR (
           recipientUserId IS NULL
           AND (targetRoles IS NULL OR FIND_IN_SET(?, targetRoles) > 0)
         )
       )
       AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     ORDER BY createdAt DESC
     LIMIT ?`,
    { replacements: [tenantId, userId, userRole, limit] },
  );
  return rows as PlatformEvent[];
}

/**
 * Counts unread (pending + sent) events for a user within the last 7 days.
 */
export async function countUnreadEventsForUser(
  database: any,
  tenantId: string,
  userId: string,
  userRole: string,
): Promise<number> {
  const [rows] = await database.sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM platform_events
     WHERE tenantId = ?
       AND deliveryStatus IN ('pending', 'sent')
       AND (
         recipientUserId = ?
         OR (
           recipientUserId IS NULL
           AND (targetRoles IS NULL OR FIND_IN_SET(?, targetRoles) > 0)
         )
       )
       AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    { replacements: [tenantId, userId, userRole] },
  );
  return Number((rows as any)[0]?.cnt || 0);
}

/**
 * Deletes platform events older than 30 days. Call periodically.
 */
export async function cleanupOldPlatformEvents(database: any): Promise<void> {
  await database.sequelize.query(
    `DELETE FROM platform_events WHERE createdAt < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
  );
}
