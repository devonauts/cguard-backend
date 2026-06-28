/**
 * Support-ticket store for the Mi Seguridad client app (Feature #24, replaces the
 * app's hardcoded mailto:).
 *
 * WHY A DEDICATED TABLE (and not the `inquiries` model):
 * The existing `inquiries` model (src/database/models/inquiries.ts) is the public
 * "Contáctanos" lead form. Its REAL columns are names/city/email/phoneNumber(max
 * 10)/message(max 300)/importHash plus a REQUIRED serviceOfInterest FK — it has
 * NO status, NO clientAccountId, and NO notes/replies column, so it cannot be
 * filtered per-customer, cannot carry an open/closed status, and cannot hold a
 * reply thread. Backing tickets with it would mean inventing a service FK and
 * faking columns. Instead we add two small, isolated tables on demand, exactly
 * like `platformEventStore.ensurePlatformEventsTable` does (CREATE TABLE IF NOT
 * EXISTS at first use) — additive, owned by this feature, breaks nothing.
 *
 * Tenant + client isolation is manual and mandatory: every row carries tenantId +
 * clientAccountId and every read filters both.
 */
import { v4 as uuidv4 } from 'uuid';

let ensured = false;

/** Lazily create the support-ticket tables (idempotent; mirrors platformEventStore). */
export async function ensureSupportTicketTables(db: any): Promise<void> {
  if (ensured) return;
  await db.sequelize.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id              VARCHAR(36)  NOT NULL,
      tenantId        VARCHAR(36)  NOT NULL,
      clientAccountId VARCHAR(36)  NOT NULL,
      userId          VARCHAR(36)  DEFAULT NULL,
      subject         VARCHAR(255) NOT NULL,
      message         TEXT         NOT NULL,
      category        VARCHAR(80)  DEFAULT NULL,
      status          VARCHAR(20)  NOT NULL DEFAULT 'abierto',
      createdAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_st_tenant_client (tenantId, clientAccountId),
      INDEX idx_st_status (status),
      INDEX idx_st_created (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.sequelize.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_replies (
      id          VARCHAR(36)  NOT NULL,
      tenantId    VARCHAR(36)  NOT NULL,
      ticketId    VARCHAR(36)  NOT NULL,
      authorType  VARCHAR(20)  NOT NULL DEFAULT 'client',
      authorId    VARCHAR(36)  DEFAULT NULL,
      message     TEXT         NOT NULL,
      createdAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_str_ticket (ticketId),
      INDEX idx_str_tenant (tenantId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  ensured = true;
}

export interface SupportTicketRow {
  id: string;
  tenantId: string;
  clientAccountId: string;
  userId: string | null;
  subject: string;
  message: string;
  category: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Create a ticket. Returns the new ticket id. */
export async function createTicket(
  db: any,
  input: {
    tenantId: string;
    clientAccountId: string;
    userId?: string | null;
    subject: string;
    message: string;
    category?: string | null;
  },
): Promise<string> {
  await ensureSupportTicketTables(db);
  const id = uuidv4();
  await db.sequelize.query(
    `INSERT INTO support_tickets
       (id, tenantId, clientAccountId, userId, subject, message, category, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'abierto', NOW(), NOW())`,
    {
      replacements: [
        id,
        input.tenantId,
        input.clientAccountId,
        input.userId || null,
        input.subject,
        input.message,
        input.category || null,
      ],
    },
  );
  return id;
}

/** List a client's own tickets (newest first) + total count. */
export async function listTickets(
  db: any,
  tenantId: string,
  clientAccountId: string,
  limit = 100,
): Promise<{ rows: SupportTicketRow[]; count: number }> {
  await ensureSupportTicketTables(db);
  const [rows]: any = await db.sequelize.query(
    `SELECT id, tenantId, clientAccountId, userId, subject, message, category, status, createdAt, updatedAt
       FROM support_tickets
      WHERE tenantId = ? AND clientAccountId = ?
      ORDER BY createdAt DESC
      LIMIT ?`,
    { replacements: [tenantId, clientAccountId, limit] },
  );
  const [countRows]: any = await db.sequelize.query(
    `SELECT COUNT(*) AS c FROM support_tickets WHERE tenantId = ? AND clientAccountId = ?`,
    { replacements: [tenantId, clientAccountId] },
  );
  return { rows: rows || [], count: Number(countRows?.[0]?.c) || 0 };
}

/** Load one ticket (scoped to tenant + client) or null. */
export async function getTicket(
  db: any,
  tenantId: string,
  clientAccountId: string,
  ticketId: string,
): Promise<SupportTicketRow | null> {
  await ensureSupportTicketTables(db);
  const [rows]: any = await db.sequelize.query(
    `SELECT id, tenantId, clientAccountId, userId, subject, message, category, status, createdAt, updatedAt
       FROM support_tickets
      WHERE tenantId = ? AND clientAccountId = ? AND id = ?
      LIMIT 1`,
    { replacements: [tenantId, clientAccountId, ticketId] },
  );
  return (rows && rows[0]) || null;
}

/** The reply thread for a ticket (oldest first). */
export async function listReplies(db: any, tenantId: string, ticketId: string): Promise<any[]> {
  await ensureSupportTicketTables(db);
  const [rows]: any = await db.sequelize.query(
    `SELECT id, ticketId, authorType, authorId, message, createdAt
       FROM support_ticket_replies
      WHERE tenantId = ? AND ticketId = ?
      ORDER BY createdAt ASC`,
    { replacements: [tenantId, ticketId] },
  );
  return rows || [];
}

/** Append a reply to a ticket and bump the ticket's updatedAt. Returns reply id. */
export async function addReply(
  db: any,
  input: {
    tenantId: string;
    ticketId: string;
    authorType: 'client' | 'staff';
    authorId?: string | null;
    message: string;
  },
): Promise<string> {
  await ensureSupportTicketTables(db);
  const id = uuidv4();
  await db.sequelize.query(
    `INSERT INTO support_ticket_replies
       (id, tenantId, ticketId, authorType, authorId, message, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    {
      replacements: [id, input.tenantId, input.ticketId, input.authorType, input.authorId || null, input.message],
    },
  );
  await db.sequelize.query(`UPDATE support_tickets SET updatedAt = NOW() WHERE id = ? AND tenantId = ?`, {
    replacements: [input.ticketId, input.tenantId],
  });
  return id;
}
