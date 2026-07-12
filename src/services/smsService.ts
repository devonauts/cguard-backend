/**
 * SMS delivery via Twilio.
 *
 * Activation: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER
 * (or TWILIO_MESSAGING_SERVICE_SID) in the backend env AND `npm i twilio`.
 * Until then every call is a safe no-op (notifications still appear in-app and
 * via email). Mirrors the pushService pattern.
 */
let _client: any = null;
let _initialized = false;

function getClient(): any {
  if (_initialized) return _client;
  _initialized = true;
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      console.warn('[sms] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — SMS disabled (in-app/email only)');
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    _client = twilio(sid, token);
  } catch (e: any) {
    console.warn('[sms] twilio SDK unavailable — SMS disabled:', e?.message || e);
    _client = null;
  }
  return _client;
}

function normalize(phone: string): string | null {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  // Keep a leading + and digits only.
  const cleaned = trimmed.replace(/(?!^\+)[^\d]/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

export async function sendSms(to: string | string[], body: string) {
  const client = getClient();
  const from = process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const recipients = Array.from(
    new Set((Array.isArray(to) ? to : [to]).map(normalize).filter(Boolean) as string[]),
  );

  if (!client || recipients.length === 0 || (!from && !messagingServiceSid)) {
    return { sent: 0, skipped: true };
  }

  let sent = 0;
  for (const number of recipients) {
    try {
      const msg: any = { to: number, body: String(body || '').slice(0, 1500) };
      if (messagingServiceSid) msg.messagingServiceSid = messagingServiceSid;
      else msg.from = from;
      await client.messages.create(msg);
      sent += 1;
    } catch (e: any) {
      console.warn('[sms] send failed to', number, ':', e?.message || e);
    }
  }
  return { sent };
}

/**
 * FAIL-CLOSED per-segment floor when no communicationProviderRates row matches
 * a recipient — mirrors the messageRouter's floor. Never bill 0 for a paid send.
 */
const FALLBACK_SMS_SEGMENT_CENTS = 10;

/**
 * Send SMS on behalf of a tenant: via the tenant's own Twilio subaccount, paid
 * from the UNIFIED communications wallet (communicationWallets — the legacy
 * tenantSmsAccount balance was migrated there and retired, see migration
 * z20260713b). Billing is PER SEGMENT at the recipient-country rate from
 * communicationProviderRates (reserve → send → refund on failure). An
 * smsTransaction ledger row is still written per send so the SMS history page
 * keeps working. Skips silently when the subaccount/sender isn't provisioned
 * or the balance is insufficient.
 *
 * `opts.title` lets callers (the notificationDispatcher) pass title + body
 * separately so the central sanitizer joins them as 'title: body'.
 */
export async function sendSmsForTenant(
  db: any,
  tenantId: string,
  to: string | string[],
  body: string,
  opts: { title?: string } = {},
) {
  const {
    getAccount,
    ensureLocalAccount,
    subaccountClient,
  } = require('./smsAccountService');
  const {
    debitWallet,
    creditWallet,
    estimateCost,
  } = require('./communication/communicationSettingsService');
  const { toSmsBody } = require('./communication/smsText');

  const recipients = Array.from(
    new Set((Array.isArray(to) ? to : [to]).map(normalize).filter(Boolean) as string[]),
  );
  if (recipients.length === 0) return { sent: 0, skipped: true };

  // Central sanitizer: emoji strip + accent folding + word-boundary truncation
  // + the billable segment count (same pure function the unified router uses).
  const sms = toSmsBody(opts.title, body);
  if (!sms.text) return { sent: 0, skipped: true, reason: 'empty_body' };

  const snapshot = await getAccount(db, tenantId);
  if (!snapshot.provisioned) return { sent: 0, skipped: true, reason: 'no_subaccount' };
  if (!snapshot.hasSender) return { sent: 0, skipped: true, reason: 'no_sender' };

  const row = await ensureLocalAccount(db, tenantId);
  const client = subaccountClient(row);
  if (!client) return { sent: 0, skipped: true, reason: 'twilio_unavailable' };

  const from = row.phoneNumber || null;
  const messagingServiceSid = row.messagingServiceSid || null;

  let sent = 0;
  for (const number of recipients) {
    // Recipient-derived country pricing (longest-prefix match inside
    // estimateCost); fail-closed floor when no rate row matches.
    let price = 0;
    try {
      const est = await estimateCost(db, 'twilio', 'sms', number, null);
      const perSegment = est.matched ? est.costCents : FALLBACK_SMS_SEGMENT_CENTS;
      price = perSegment * sms.segments;
    } catch (e: any) {
      console.error('[sms] estimateCost failed for', number, ':', e?.message || e);
      price = FALLBACK_SMS_SEGMENT_CENTS * sms.segments;
    }

    // RESERVE before the Twilio call (refunded below on failure). debitWallet
    // refuses on insufficient balance unless the tenant allows negative.
    let reserved = 0;
    let balanceAfter: number | null = null;
    try {
      const deb = await debitWallet(db, tenantId, price);
      if (!deb.ok) {
        console.warn('[sms] tenant send skipped (insufficient communications balance) to', number);
        continue;
      }
      reserved = price;
      balanceAfter = deb.balanceAfterCents;
    } catch (e: any) {
      console.error('[sms] wallet reserve debit FAILED for tenant', tenantId, ':', e?.message || e);
      continue; // fail-closed: never send unbilled
    }

    try {
      const msg: any = { to: number, body: sms.text.slice(0, 1500) };
      if (messagingServiceSid) msg.messagingServiceSid = messagingServiceSid;
      else msg.from = from;
      const res = await client.messages.create(msg);
      sent += 1;

      // Legacy ledger row (SMS history page) — best-effort.
      try {
        await db.smsTransaction.create({
          tenantId,
          type: 'debit',
          amountCents: -price,
          balanceAfterCents: balanceAfter,
          smsCount: sms.segments,
          currency: 'USD',
          reference: res?.sid || null,
          description: `Envío de SMS (${sms.segments} segmento${sms.segments === 1 ? '' : 's'})`,
        });
      } catch (e: any) {
        console.warn('[sms] smsTransaction ledger write failed:', e?.message || e);
      }
    } catch (e: any) {
      console.warn('[sms] tenant send failed to', number, ':', e?.message || e);
      // Refund the reservation — the message never went out.
      try {
        await creditWallet(db, tenantId, reserved);
      } catch (err: any) {
        console.error(
          `[sms] REFUND after failed send FAILED (tenant overcharged) tenant=${tenantId} cents=${reserved}:`,
          err?.message || err,
        );
      }
    }
  }
  return { sent };
}

export default { sendSms, sendSmsForTenant };
