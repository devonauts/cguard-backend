/**
 * Email audit trail → superAdminAuditLog (visible in the SuperAdmin "Audit log").
 *
 * Records both OUTBOUND send attempts (email.sent / email.send_failed / email.skipped)
 * from the mail chokepoints, and DELIVERY events (email.delivered / bounce / dropped /
 * open / …) received from the SendGrid Event Webhook. Writes are fire-and-forget and
 * fully swallowed — auditing must NEVER break an email send.
 *
 * This runs outside any express request, so it resolves its own DB handle (memoized)
 * the same way other non-request services do.
 */
import models from '../database/models';

let _db: any = null;
function getDb(): any {
  if (_db) return _db;
  try {
    _db = (models as any)();
  } catch {
    _db = null;
  }
  return _db;
}

export interface EmailAuditOpts {
  to?: string | null;
  subject?: string | null;
  tenantId?: string | null;
  transport?: string | null;
  messageId?: string | null;
  reason?: string | null;
  error?: string | null;
  details?: Record<string, any>;
}

/**
 * Write one email event to the platform audit log.
 * `action` is an `email.*` verb (email.sent, email.delivered, email.bounce, …).
 */
export async function auditEmail(action: string, opts: EmailAuditOpts = {}): Promise<void> {
  try {
    const db = getDb();
    if (!db?.superAdminAuditLog) return;
    const details: Record<string, any> = {
      to: opts.to ?? null,
      subject: opts.subject ?? null,
      transport: opts.transport ?? null,
      messageId: opts.messageId ?? null,
      reason: opts.reason ?? null,
      error: opts.error ?? null,
      ...(opts.details || {}),
    };
    await db.superAdminAuditLog.create({
      actorUserId: null,
      actorEmail: 'system',
      action,
      targetType: 'email',
      targetId: opts.to ? String(opts.to).slice(0, 64) : null,
      tenantId: opts.tenantId ?? null,
      method: null,
      path: null,
      ip: null,
      statusCode: null,
      details,
    });
  } catch {
    /* never break the email flow because auditing failed */
  }
}

/** Pull a SendGrid x-message-id out of a @sendgrid/mail send response, if present. */
export function messageIdFromSendgridResponse(res: any): string | null {
  try {
    const h = Array.isArray(res) ? res[0]?.headers : res?.headers;
    return h?.['x-message-id'] || h?.['X-Message-Id'] || null;
  } catch {
    return null;
  }
}
