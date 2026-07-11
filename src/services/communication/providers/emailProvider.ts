/**
 * emailProvider — wraps the existing src/services/mailService.ts (sendMail).
 * Email is FREE and is never wallet-gated by the router.
 *
 * NON-BREAKING: reuses mailService.sendMail (SendGrid or SMTP, per env) rather
 * than reimplementing a transport.
 *
 * recipient: OutboundMessage.recipient is the destination email address.
 * title → subject; body → html (also sent as text for plain clients).
 */
import { CommunicationProvider, OutboundMessage, SendResult, MessageType } from '../types';
import { sendMail } from '../../mailService';
import { renderNotificationEmail } from '../../../lib/emailLayout';

/** Map a messageType to a Spanish eyebrow label shown in the branded header. */
const EYEBROW_BY_TYPE: Partial<Record<MessageType, string>> = {
  shift_reminder: 'Recordatorio de turno',
  incident_alert: 'Alerta de incidente',
  visitor_alert: 'Alerta de visitante',
  ronda_alert: 'Alerta de ronda',
  task_alert: 'Alerta de tarea',
  no_show: 'Inasistencia',
  panic: 'Alerta de pánico',
  new_assignment: 'Nueva asignación',
  escalation: 'Escalamiento',
  otp: 'Código de verificación',
  generic: 'Notificación',
};

/**
 * Resolve the tenant's display name + own logo URL for the branded email header.
 * Defensive: any lookup failure returns empties (the template handles missing
 * name/logo gracefully). Mirrors emailSender's settings.logoUrl resolution.
 */
async function resolveTenantBranding(db: any, tenantId?: string): Promise<{ tenantName: string; logoUrl: string }> {
  let tenantName = '';
  let logoUrl = '';
  if (!db || !tenantId) return { tenantName, logoUrl };
  try {
    const settings = await db.settings?.findOne?.({ where: { tenantId } });
    if (settings) {
      logoUrl = settings.logoUrl || settings.get?.('logoUrl') || '';
    }
  } catch (e) {
    // ignore — proceed with empty logo
  }
  try {
    const tenant = await db.tenant?.findByPk?.(tenantId);
    if (tenant) {
      tenantName = tenant.name || tenant.get?.('name') || tenant.displayName || '';
    }
  } catch (e) {
    // ignore — proceed with empty name
  }
  return { tenantName, logoUrl };
}

/** Pull a provider message id out of the various transport responses. */
function extractMessageId(res: any): string | undefined {
  if (!res) return undefined;
  // nodemailer SMTP response.
  if (typeof res.messageId === 'string') return res.messageId;
  // SendGrid returns [response, body]; the id is in the x-message-id header.
  if (Array.isArray(res) && res[0]?.headers) {
    const h = res[0].headers;
    return h['x-message-id'] || h['X-Message-Id'] || undefined;
  }
  return undefined;
}

export class EmailProvider implements CommunicationProvider {
  channel = 'email' as const;

  /**
   * Configured when a transport is available: SendGrid (SENDGRID_API_KEY) or
   * SMTP (MAIL_SERVER). mailService.sendMail throws when neither is set, so we
   * gate on the same env here to let the router skip cleanly instead.
   */
  async isConfigured(_db: any, _tenantId: string): Promise<boolean> {
    return !!(process.env.SENDGRID_API_KEY || process.env.MAIL_SERVER);
  }

  async send(_db: any, msg: OutboundMessage): Promise<SendResult> {
    const to = String(msg.recipient || '').trim();
    if (!to) {
      return { status: 'skipped', channel: 'email', provider: 'smtp', skipReason: 'no_recipient' };
    }

    const subject = msg.title || msg.body || 'Notificación';
    const body = msg.body || '';

    // Resolve the tenant's branding for the global notification template.
    const { tenantName, logoUrl } = await resolveTenantBranding(_db, msg.tenantId);
    // Brand colors (accent + header) from Preferencias de Correo.
    let brandColor: string | undefined;
    let headerColor: string | undefined;
    try {
      const { getEmailBranding } = require('../../../lib/emailLayout');
      const brand = await getEmailBranding(_db, msg.tenantId);
      brandColor = brand?.brandColor;
      headerColor = brand?.headerColor;
    } catch { /* defaults apply in the renderer */ }

    // CTA: msg.deepLink is a cguardpro:// scheme that email clients can't open
    // reliably, so we never put it in the button. Only render a CTA when a real
    // https URL is available (FRONTEND_URL); otherwise omit the button entirely.
    const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    const ctaUrl = frontendUrl ? frontendUrl : undefined;
    const ctaText = ctaUrl ? 'Abrir C-Guard Pro' : undefined;

    const html = renderNotificationEmail({
      tenantName,
      logoUrl,
      brandColor,
      headerColor,
      eyebrow: EYEBROW_BY_TYPE[msg.messageType] || 'Notificación',
      title: msg.title || subject,
      body,
      ctaUrl,
      ctaText,
    });

    try {
      const res: any = await sendMail({
        to,
        subject,
        html,
        text: body || undefined,
      });
      return {
        status: 'sent',
        channel: 'email',
        provider: process.env.SENDGRID_API_KEY ? 'sendgrid' : 'smtp',
        providerMessageId: extractMessageId(res),
        providerResponse: { ok: true },
      };
    } catch (e: any) {
      return {
        status: 'failed',
        channel: 'email',
        provider: process.env.SENDGRID_API_KEY ? 'sendgrid' : 'smtp',
        error: e?.message || String(e),
      };
    }
  }
}

export const emailProvider = new EmailProvider();
export default emailProvider;
