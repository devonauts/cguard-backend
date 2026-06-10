/**
 * Security audit logging — auth / session / device events. Best-effort; never throws.
 */

/** Extract client IP + user-agent from an Express request (proxy-aware). */
export function clientCtx(req: any): { ip: string | null; userAgent: string | null } {
  if (!req) return { ip: null, userAgent: null };
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip =
    (typeof fwd === 'string' && fwd.split(',')[0].trim()) ||
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    null;
  const ua = req.headers && req.headers['user-agent'];
  return {
    ip: ip ? String(ip).slice(0, 60) : null,
    userAgent: ua ? String(ua).slice(0, 400) : null,
  };
}

export async function logSecurityEvent(
  db: any,
  ev: {
    tenantId?: string | null;
    userId?: string | null;
    email?: string | null;
    event: string;
    outcome?: 'success' | 'failure';
    ip?: string | null;
    userAgent?: string | null;
    deviceId?: string | null;
    platform?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  try {
    if (!db || !db.securityAuditLog) return;
    await db.securityAuditLog.create({
      tenantId: ev.tenantId || null,
      userId: ev.userId || null,
      email: ev.email ? String(ev.email).slice(0, 255) : null,
      event: ev.event,
      outcome: ev.outcome || null,
      ip: ev.ip || null,
      userAgent: ev.userAgent || null,
      deviceId: ev.deviceId ? String(ev.deviceId).slice(0, 200) : null,
      platform: ev.platform ? String(ev.platform).slice(0, 40) : null,
      detail: ev.detail ? String(ev.detail).slice(0, 2000) : null,
      at: new Date(),
    });
  } catch (e: any) {
    console.warn('[security-audit] log failed:', e?.message || e);
  }
}
