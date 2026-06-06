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
 * Send SMS on behalf of a tenant: via the tenant's own Twilio subaccount, paid
 * from its prepaid wallet (one debit per delivered message). Skips silently
 * when the subaccount/sender isn't provisioned or the balance is insufficient.
 */
export async function sendSmsForTenant(
  db: any,
  tenantId: string,
  to: string | string[],
  body: string,
) {
  const {
    getAccount,
    ensureLocalAccount,
    subaccountClient,
    debit,
  } = require('./smsAccountService');

  const recipients = Array.from(
    new Set((Array.isArray(to) ? to : [to]).map(normalize).filter(Boolean) as string[]),
  );
  if (recipients.length === 0) return { sent: 0, skipped: true };

  const snapshot = await getAccount(db, tenantId);
  const price = snapshot.pricePerSmsCents;
  if (!snapshot.provisioned) return { sent: 0, skipped: true, reason: 'no_subaccount' };
  if (!snapshot.hasSender) return { sent: 0, skipped: true, reason: 'no_sender' };
  if (snapshot.balanceCents < price) return { sent: 0, skipped: true, reason: 'insufficient_balance' };

  const row = await ensureLocalAccount(db, tenantId);
  const client = subaccountClient(row);
  if (!client) return { sent: 0, skipped: true, reason: 'twilio_unavailable' };

  const from = row.phoneNumber || null;
  const messagingServiceSid = row.messagingServiceSid || null;

  let balance = snapshot.balanceCents;
  let sent = 0;
  for (const number of recipients) {
    if (balance < price) break;
    try {
      const msg: any = { to: number, body: String(body || '').slice(0, 1500) };
      if (messagingServiceSid) msg.messagingServiceSid = messagingServiceSid;
      else msg.from = from;
      const res = await client.messages.create(msg);
      const deb = await debit(db, tenantId, price, {
        reference: res?.sid,
        description: 'Envío de SMS',
        smsCount: 1,
      });
      balance = deb.balanceAfterCents;
      sent += 1;
    } catch (e: any) {
      console.warn('[sms] tenant send failed to', number, ':', e?.message || e);
    }
  }
  return { sent };
}

export default { sendSms, sendSmsForTenant };
