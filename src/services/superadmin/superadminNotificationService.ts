/**
 * Platform notification center service (SuperAdmin).
 *
 * Persists superadminNotification rows and fans out live updates to all
 * superadmin browsers via emitSuperadminEvent. Platform-scoped (no tenant).
 *
 * Socket events (EXACT names — the frontend NotificationContext listens):
 *   'superadmin:notification'         { notification }   // new row created
 *   'superadmin:notification:update'  { unread }         // counts changed
 */
import { Op } from 'sequelize';
import { emitSuperadminEvent } from '../../lib/realtime';

export interface CreateNotificationArgs {
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  metadata?: any;
}

function serialize(n: any) {
  if (!n) return null;
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    icon: n.icon,
    isRead: !!n.isRead,
    metadata: n.metadata,
    createdAt: n.createdAt,
  };
}

async function unreadCount(database: any): Promise<number> {
  return database.superadminNotification.count({ where: { isRead: false } });
}

async function emitCounts(database: any): Promise<void> {
  try {
    emitSuperadminEvent('superadmin:notification:update', { unread: await unreadCount(database) });
  } catch {
    /* best-effort */
  }
}

/** Create a notification + push it live. Never throws into the caller. */
export async function createNotification(database: any, args: CreateNotificationArgs) {
  try {
    const row = await database.superadminNotification.create({
      type: args.type,
      title: args.title,
      body: args.body || null,
      link: args.link || null,
      icon: args.icon || null,
      metadata: args.metadata || null,
      isRead: false,
    });
    const notification = serialize(row);
    try {
      emitSuperadminEvent('superadmin:notification', { notification });
    } catch {
      /* best-effort */
    }
    void emitCounts(database);
    return notification;
  } catch (e: any) {
    console.error('[superadminNotification] create failed:', e?.message || e);
    return null;
  }
}

export async function listNotifications(
  database: any,
  opts: { page?: number; limit?: number; isRead?: boolean; type?: string; search?: string },
) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const where: any = {};
  if (typeof opts.isRead === 'boolean') where.isRead = opts.isRead;
  if (opts.type) where.type = opts.type;
  if (opts.search) {
    where[Op.or] = [
      { title: { [Op.like]: `%${opts.search}%` } },
      { body: { [Op.like]: `%${opts.search}%` } },
    ];
  }
  const { rows, count } = await database.superadminNotification.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    rows: rows.map(serialize),
    total: count,
    page,
    limit,
    unread: await unreadCount(database),
  };
}

export async function getUnreadCount(database: any) {
  return { unread: await unreadCount(database) };
}

export async function markRead(database: any, id: string, isRead = true) {
  const row = await database.superadminNotification.findByPk(id);
  if (!row) return null;
  await row.update({ isRead });
  void emitCounts(database);
  return serialize(row);
}

export async function markAllRead(database: any) {
  await database.superadminNotification.update({ isRead: true }, { where: { isRead: false } });
  void emitCounts(database);
  return { ok: true, unread: 0 };
}

export async function removeNotification(database: any, id: string) {
  const n = await database.superadminNotification.destroy({ where: { id } });
  void emitCounts(database);
  return { ok: n > 0 };
}

export async function clearAll(database: any, onlyRead = false) {
  const where = onlyRead ? { isRead: true } : {};
  const n = await database.superadminNotification.destroy({ where, truncate: false });
  void emitCounts(database);
  return { ok: true, deleted: n };
}

export default {
  createNotification,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  removeNotification,
  clearAll,
};
