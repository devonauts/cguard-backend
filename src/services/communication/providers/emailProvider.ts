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
import { CommunicationProvider, OutboundMessage, SendResult } from '../types';
import { sendMail } from '../../mailService';

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

    try {
      const res: any = await sendMail({
        to,
        subject,
        html: body || undefined,
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
