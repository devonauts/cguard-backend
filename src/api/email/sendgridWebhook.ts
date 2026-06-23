/**
 * SendGrid Event Webhook → platform audit log.
 *
 * SendGrid POSTs a JSON array of delivery events (delivered, bounce, dropped,
 * open, click, spamreport, deferred, …). We record each as an `email.<event>`
 * entry in superAdminAuditLog so the SuperAdmin "Audit log" shows true delivery
 * outcomes per recipient — not just that we attempted a send.
 *
 * Mounted PRE-AUTH (SendGrid can't carry our JWT). Optional shared-secret guard:
 * if SENDGRID_WEBHOOK_SECRET is set, the configured webhook URL must include
 * `?key=<secret>` or the request is ignored. Always answers 2xx so SendGrid
 * doesn't enter a retry storm.
 */
import { auditEmail } from '../../lib/emailAudit';

/** SendGrid event name → audit action. Unknown events fall back to email.<event>. */
const EVENT_ACTION: Record<string, string> = {
  processed: 'email.processed',
  delivered: 'email.delivered',
  open: 'email.open',
  click: 'email.click',
  bounce: 'email.bounce',
  dropped: 'email.dropped',
  deferred: 'email.deferred',
  spamreport: 'email.spamreport',
  blocked: 'email.blocked',
  unsubscribe: 'email.unsubscribe',
  group_unsubscribe: 'email.unsubscribe',
  group_resubscribe: 'email.resubscribe',
};

const MAX_EVENTS = 500; // safety cap per delivery

export async function sendgridEventWebhook(req: any, res: any) {
  try {
    const secret = process.env.SENDGRID_WEBHOOK_SECRET;
    if (secret && String(req.query?.key || '') !== secret) {
      // Wrong/missing key — ack so SendGrid won't retry, but record nothing.
      return res.status(204).end();
    }

    const events: any[] = Array.isArray(req.body) ? req.body : [];
    for (const ev of events.slice(0, MAX_EVENTS)) {
      const name = String(ev?.event || '').toLowerCase();
      const action = EVENT_ACTION[name] || `email.${name || 'event'}`;
      await auditEmail(action, {
        to: ev?.email || null,
        subject: ev?.subject || null,
        // tenantId / purpose flow through if we attach them as SendGrid custom_args.
        tenantId: ev?.tenantId || ev?.tenant_id || null,
        messageId: ev?.sg_message_id || null,
        reason: ev?.reason || ev?.response || ev?.status || ev?.type || null,
        details: {
          event: ev?.event || null,
          sg_event_id: ev?.sg_event_id || null,
          type: ev?.type || null,
          bounce_classification: ev?.bounce_classification || null,
          ip: ev?.ip || null,
          useragent: ev?.useragent || null,
          url: ev?.url || null,
          timestamp: ev?.timestamp || null,
        },
      });
    }
    return res.status(204).end();
  } catch {
    // Always ack to avoid SendGrid retry storms; failures are non-fatal.
    return res.status(204).end();
  }
}

export default { sendgridEventWebhook };
