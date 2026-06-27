/**
 * communicationLogService — the single writer/reader of communicationLogs.
 *
 * - log(): persist one delivery attempt (best-effort; never throws into the
 *   send path — logging failures are swallowed and warned).
 * - updateStatusByProviderMessageId(): called from webhooks (e.g. Meta WhatsApp
 *   status callbacks) to advance a row's status + timestamp.
 * - queryLogs(): tenant-scoped, paginated, filtered feed for the admin endpoint.
 *
 * Every query is tenant-scoped. The model is src/database/models/communicationLog.ts
 * (table communicationLogs).
 */
import { Channel, DeliveryStatus, MessageType } from './types';

export interface LogInput {
  tenantId: string;
  userId?: string | null;
  recipient?: string | null;
  channel: Channel;
  provider?: string | null;
  messageType: MessageType;
  status: DeliveryStatus;
  providerMessageId?: string | null;
  providerResponse?: any;
  errorMessage?: string | null;
  costEstimateCents?: number | null;
  billedAmountCents?: number | null;
  currency?: string;
  deepLink?: string | null;
}

function stampForStatus(status: DeliveryStatus, at: Date) {
  if (status === 'delivered') return { deliveredAt: at };
  if (status === 'read') return { readAt: at, deliveredAt: at };
  if (status === 'failed') return { failedAt: at };
  return {};
}

/** Persist a single delivery attempt. Returns the created row id (or null). */
export async function log(db: any, input: LogInput): Promise<string | null> {
  try {
    const now = new Date();
    const row = await db.communicationLog.create({
      tenantId: input.tenantId,
      userId: input.userId || null,
      recipient: input.recipient || null,
      channel: input.channel,
      provider: input.provider || null,
      messageType: input.messageType || 'generic',
      status: input.status,
      providerMessageId: input.providerMessageId || null,
      providerResponse: input.providerResponse ?? null,
      errorMessage: input.errorMessage || null,
      costEstimateCents: input.costEstimateCents ?? null,
      billedAmountCents: input.billedAmountCents ?? null,
      currency: input.currency || 'USD',
      deepLink: input.deepLink || null,
      ...stampForStatus(input.status, now),
    });
    return row?.id || null;
  } catch (e: any) {
    console.warn('[communicationLog] log failed:', e?.message || e);
    return null;
  }
}

/**
 * Advance a row's status by providerMessageId (webhook callbacks). Not
 * tenant-scoped on input because providerMessageId is globally unique per
 * provider; the lookup itself isolates the row. Returns true when a row updated.
 */
export async function updateStatusByProviderMessageId(
  db: any,
  providerMessageId: string,
  status: DeliveryStatus,
  at: Date = new Date(),
): Promise<boolean> {
  if (!providerMessageId) return false;
  try {
    const row = await db.communicationLog.findOne({ where: { providerMessageId } });
    if (!row) return false;
    await row.update({ status, ...stampForStatus(status, at) });
    return true;
  } catch (e: any) {
    console.warn('[communicationLog] updateStatusByProviderMessageId failed:', e?.message || e);
    return false;
  }
}

export interface LogQuery {
  channel?: string;
  provider?: string;
  status?: string;
  messageType?: string;
  type?: string; // alias for messageType
  from?: string | Date;
  to?: string | Date;
  page?: number;
  limit?: number;
}

/** Tenant-scoped, paginated, filtered log feed for the admin endpoint. */
export async function queryLogs(db: any, tenantId: string, q: LogQuery = {}) {
  const { Op } = require('sequelize');
  const where: any = { tenantId };

  if (q.channel) where.channel = q.channel;
  if (q.provider) where.provider = q.provider;
  if (q.status) where.status = q.status;
  const mt = q.messageType || q.type;
  if (mt) where.messageType = mt;

  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt[Op.gte] = new Date(q.from);
    if (q.to) where.createdAt[Op.lte] = new Date(q.to);
  }

  const limit = Math.min(Math.max(parseInt(String(q.limit ?? 50), 10) || 50, 1), 200);
  const page = Math.max(parseInt(String(q.page ?? 1), 10) || 1, 1);
  const offset = (page - 1) * limit;

  const { rows, count } = await db.communicationLog.findAndCountAll({
    where,
    // Exclude the heavy `providerResponse` JSON blob from the list payload — the
    // admin Comunicaciones log feed never renders it (status/errorMessage carry
    // the surfaced info). Kept in the DB / available to webhooks.
    attributes: { exclude: ['providerResponse'] },
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    rows: rows.map((r: any) => (r.get ? r.get({ plain: true }) : r)),
    count,
    page,
    limit,
    totalPages: Math.ceil(count / limit) || 1,
  };
}

export default { log, updateStatusByProviderMessageId, queryLogs };
