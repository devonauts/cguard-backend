/**
 * twilioSmsProvider — SMS delivery via Twilio, the unified-comms FALLBACK channel.
 *
 * NON-BREAKING + WALLET DECISION (important):
 *   The legacy `sendSmsForTenant` (src/services/smsService.ts) debits the LEGACY
 *   `tenantSmsAccount` prepaid wallet on each delivered message. In the unified
 *   layer, the MessageRouter is the single owner of billing and debits the
 *   `communicationWallet` after a successful send. If this provider called
 *   `sendSmsForTenant`, the tenant would be charged TWICE (once on each wallet).
 *
 *   To avoid the double-debit we do a LOW-LEVEL Twilio send here using the
 *   tenant's already-provisioned Twilio subaccount + sender (reusing
 *   `ensureLocalAccount` / `subaccountClient` from smsAccountService — the same
 *   infrastructure the legacy path uses) and leave ALL wallet movement to the
 *   router (communicationWallet via communicationSettingsService). We deliberately
 *   do NOT call `sendSmsForTenant` and do NOT touch tenantSmsAccount here.
 *
 *   This keeps the legacy SMS stack (sendSmsForTenant) untouched and working for
 *   its existing callers, while the unified layer bills exactly once.
 *
 * Recipient: OutboundMessage.recipient is the destination phone, E.164-normalized.
 */
import { CommunicationProvider, OutboundMessage, SendResult } from '../types';

/** E.164 normalization: keep a leading + and digits only; reject too-short. */
function toE164(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/(?!^\+)[^\d]/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

export class TwilioSmsProvider implements CommunicationProvider {
  channel = 'sms' as const;

  /**
   * Configured when the tenant has a provisioned subaccount + sender and the
   * Twilio SDK is available. Mirrors the legacy snapshot checks so the router's
   * `isConfigured` gate behaves the same as the legacy `sendSmsForTenant`.
   */
  async isConfigured(db: any, tenantId: string): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getAccount, ensureLocalAccount, subaccountClient } = require('../../smsAccountService');
      const snapshot = await getAccount(db, tenantId);
      if (!snapshot.provisioned || !snapshot.hasSender) return false;
      const row = await ensureLocalAccount(db, tenantId);
      return !!subaccountClient(row);
    } catch {
      // Fall back to platform-level Twilio presence so the router can still try.
      return !!(process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_MASTER_ACCOUNT_SID);
    }
  }

  async send(db: any, msg: OutboundMessage): Promise<SendResult> {
    const to = toE164(msg.recipient);
    if (!to) {
      return { status: 'skipped', channel: 'sms', provider: 'twilio', skipReason: 'no_recipient' };
    }

    let getAccount: any;
    let ensureLocalAccount: any;
    let subaccountClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ getAccount, ensureLocalAccount, subaccountClient } = require('../../smsAccountService'));
    } catch (e: any) {
      return { status: 'failed', channel: 'sms', provider: 'twilio', error: e?.message || String(e) };
    }

    try {
      const snapshot = await getAccount(db, msg.tenantId);
      if (!snapshot.provisioned) {
        return { status: 'skipped', channel: 'sms', provider: 'twilio', skipReason: 'no_subaccount' };
      }
      if (!snapshot.hasSender) {
        return { status: 'skipped', channel: 'sms', provider: 'twilio', skipReason: 'no_sender' };
      }

      const row = await ensureLocalAccount(db, msg.tenantId);
      const client = subaccountClient(row);
      if (!client) {
        return { status: 'skipped', channel: 'sms', provider: 'twilio', skipReason: 'twilio_unavailable' };
      }

      const from = row.phoneNumber || null;
      const messagingServiceSid = row.messagingServiceSid || null;
      if (!from && !messagingServiceSid) {
        return { status: 'skipped', channel: 'sms', provider: 'twilio', skipReason: 'no_sender' };
      }

      const payload: any = { to, body: String(msg.body || '').slice(0, 1500) };
      if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
      else payload.from = from;

      // Low-level send — NO wallet debit here (router owns communicationWallet).
      const res: any = await client.messages.create(payload);

      return {
        status: 'sent',
        channel: 'sms',
        provider: 'twilio',
        providerMessageId: res?.sid || undefined,
        providerResponse: { sid: res?.sid, status: res?.status, to },
      };
    } catch (e: any) {
      return {
        status: 'failed',
        channel: 'sms',
        provider: 'twilio',
        error: e?.message || String(e),
      };
    }
  }
}

export const twilioSmsProvider = new TwilioSmsProvider();
export default twilioSmsProvider;
