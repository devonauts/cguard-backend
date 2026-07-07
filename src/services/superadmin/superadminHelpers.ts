/**
 * Shared helpers for the platform superadmin API (`/api/superadmin/*`).
 *
 * These endpoints run cross-tenant, so unlike the tenant-scoped services they
 * query models directly off `req.database` without a tenant filter. Keep all
 * cross-cutting concerns (db access, audit logging, cents formatting) here so
 * every superadmin route module behaves consistently.
 */
import { Request } from 'express';

/** The Sequelize models bag attached by databaseMiddleware. */
export function db(req: Request): any {
  return (req as any).database;
}

/** The authenticated superadmin performing the request. */
export function actor(req: Request): { id?: string; email?: string } {
  const u = (req as any).currentUser || {};
  return { id: u.id, email: u.email };
}

/**
 * Append a row to the superadmin audit trail. Best-effort: auditing must never
 * break the action it records, so failures are swallowed and logged.
 */
export async function writeAudit(
  req: Request,
  entry: {
    action: string;
    targetType?: string;
    targetId?: string | null;
    tenantId?: string | null;
    statusCode?: number;
    details?: any;
  },
): Promise<void> {
  try {
    const database = db(req);
    if (!database?.superAdminAuditLog) return;
    const who = actor(req);
    await database.superAdminAuditLog.create({
      actorUserId: who.id || null,
      actorEmail: who.email || null,
      action: entry.action,
      targetType: entry.targetType || null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      tenantId: entry.tenantId || null,
      method: req.method,
      path: (req.originalUrl || '').slice(0, 512),
      ip: (req.ip || (req.socket && req.socket.remoteAddress) || '').toString().slice(0, 64),
      statusCode: entry.statusCode ?? null,
      details: entry.details ?? null,
    });
    // Mark so the router-level auto-audit middleware doesn't double-log this one.
    (req as any)._audited = true;
  } catch (err: any) {
    console.warn('superadmin audit write failed:', err?.message || err);
  }
}

/** USD cents → dollars number (2dp). */
export function centsToUsd(cents: number): number {
  return Math.round((cents || 0)) / 100;
}

/** Parse common list query params (page/limit/search) with safe bounds. */
export function listParams(query: any): { page: number; limit: number; offset: number; search: string } {
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query?.limit, 10) || 50));
  return { page, limit, offset: (page - 1) * limit, search: (query?.search || '').toString().trim() };
}
