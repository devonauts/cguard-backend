/**
 * Platform Twilio client — thin, lazily-loaded wrapper over the `twilio` SDK
 * for the SuperAdmin phone center. Every helper reads the (decrypted) platform
 * config via twilioPlatformConfigService and degrades gracefully with a clear
 * error when Twilio isn't configured.
 *
 * Public URL base for webhooks (verified): https://api.cguardpro.com
 * (api.cguardpro.com proxies straight to the app root — NO /api prefix), so
 * the webhook endpoints are:
 *   https://api.cguardpro.com/communications/webhooks/twilio/sms
 *   https://api.cguardpro.com/communications/webhooks/twilio/sms-status
 *   https://api.cguardpro.com/communications/webhooks/twilio/voice
 *   https://api.cguardpro.com/communications/webhooks/twilio/voice-status
 *   https://api.cguardpro.com/communications/webhooks/twilio/voice-outbound
 *
 * In-browser voice identity is a single shared client identity 'superadmin':
 * an inbound <Dial><Client>superadmin</Client> rings whichever superadmin
 * browser(s) are currently registered. Multiple simultaneous superadmin devices
 * share this identity (they all ring).
 */
import { getTwilioConfig } from './twilioPlatformConfigService';

/** Lazily require the twilio SDK; clear error if the dependency is missing. */
function requireTwilio(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('twilio');
  } catch (e: any) {
    throw new Error(
      'Twilio SDK not installed. Run `npm i twilio` in the backend. (' + (e?.message || e) + ')',
    );
  }
}

/** Public base URL Twilio uses to reach our webhooks (no trailing slash). */
export function publicWebhookBase(): string {
  return (process.env.TWILIO_PUBLIC_BASE_URL || 'https://api.cguardpro.com').replace(/\/+$/, '');
}

/** Absolute webhook URLs Twilio should POST to. */
export function webhookUrls() {
  const base = publicWebhookBase();
  return {
    smsUrl: `${base}/communications/webhooks/twilio/sms`,
    smsStatusUrl: `${base}/communications/webhooks/twilio/sms-status`,
    voiceUrl: `${base}/communications/webhooks/twilio/voice`,
    voiceStatusUrl: `${base}/communications/webhooks/twilio/voice-status`,
    voiceOutboundUrl: `${base}/communications/webhooks/twilio/voice-outbound`,
  };
}

/** An authenticated REST client (accountSid + authToken). Throws if unconfigured. */
export async function getClient(database: any): Promise<any> {
  const cfg = await getTwilioConfig(database);
  if (!cfg.accountSid || !cfg.authToken) {
    throw new Error('Twilio is not configured (missing Account SID / Auth Token).');
  }
  const twilio = requireTwilio();
  return twilio(cfg.accountSid, cfg.authToken);
}

/**
 * Live account balance + status. Twilio exposes the running balance and the
 * account status (active | suspended | closed) but NO API to add funds — topping
 * up is done in the Twilio billing console (or via auto-recharge). The UI uses
 * this to show the balance, flag a suspended/low account, and deep-link to the
 * billing page. `accountSid` is also returned for building that deep link.
 */
export async function getBalance(database: any): Promise<{
  ok: boolean;
  balance?: number;
  currency?: string;
  status?: string;
  accountSid?: string;
  error?: string;
}> {
  const cfg = await getTwilioConfig(database);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: 'Twilio no está configurado.' };
  }
  try {
    const client = requireTwilio()(cfg.accountSid, cfg.authToken);
    const [bal, acct] = await Promise.all([
      client.balance.fetch(),
      client.api.accounts(cfg.accountSid).fetch(),
    ]);
    return {
      ok: true,
      balance: parseFloat(bal.balance),
      currency: bal.currency || 'USD',
      status: acct.status, // active | suspended | closed
      accountSid: cfg.accountSid,
    };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || 'No se pudo obtener el saldo.' };
  }
}

export interface SendSmsArgs {
  to: string;
  body: string;
  statusCallback?: string;
}

/**
 * Send an SMS from the platform number (or messaging service). Returns the
 * Twilio message resource (sid, status, …). statusCallback defaults to our
 * sms-status webhook so delivery updates flow back in.
 */
export async function sendSms(database: any, args: SendSmsArgs): Promise<any> {
  const cfg = await getTwilioConfig(database);
  const client = await getClient(database);
  const urls = webhookUrls();
  const msg: any = {
    to: args.to,
    body: String(args.body || '').slice(0, 1600),
    statusCallback: args.statusCallback || urls.smsStatusUrl,
  };
  if (cfg.messagingServiceSid) msg.messagingServiceSid = cfg.messagingServiceSid;
  else if (cfg.phoneNumber) msg.from = cfg.phoneNumber;
  else throw new Error('No platform phone number or messaging service configured.');
  return client.messages.create(msg);
}

/** List the incoming phone numbers owned by the platform account. */
export async function listIncomingNumbers(database: any): Promise<any[]> {
  const client = await getClient(database);
  const nums = await client.incomingPhoneNumbers.list({ limit: 100 });
  return (nums || []).map((n: any) => ({
    sid: n.sid,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    smsUrl: n.smsUrl,
    voiceUrl: n.voiceUrl,
    statusCallback: n.statusCallback,
    capabilities: n.capabilities,
  }));
}

export interface ConfigureNumberArgs {
  phoneSid?: string;
  phoneNumber?: string;
  smsUrl?: string;
  voiceUrl?: string;
  statusUrls?: { smsStatusUrl?: string; voiceStatusUrl?: string };
}

/**
 * Point a platform number's SMS + Voice webhooks at our endpoints. If no URLs
 * are supplied, our canonical webhook URLs are used. Resolves the number SID
 * from phoneNumber when phoneSid isn't given.
 */
export async function configureNumberWebhooks(
  database: any,
  args: ConfigureNumberArgs,
): Promise<any> {
  const client = await getClient(database);
  const urls = webhookUrls();

  let sid = args.phoneSid;
  if (!sid) {
    if (!args.phoneNumber) throw new Error('phoneSid or phoneNumber is required.');
    const matches = await client.incomingPhoneNumbers.list({
      phoneNumber: args.phoneNumber,
      limit: 1,
    });
    if (!matches || !matches.length) {
      throw new Error(`No incoming number found matching ${args.phoneNumber}.`);
    }
    sid = matches[0].sid;
  }

  const update: any = {
    smsUrl: args.smsUrl || urls.smsUrl,
    smsMethod: 'POST',
    voiceUrl: args.voiceUrl || urls.voiceUrl,
    voiceMethod: 'POST',
    statusCallback: (args.statusUrls && args.statusUrls.voiceStatusUrl) || urls.voiceStatusUrl,
    statusCallbackMethod: 'POST',
  };
  const updated = await client.incomingPhoneNumbers(sid).update(update);
  return {
    sid: updated.sid,
    phoneNumber: updated.phoneNumber,
    smsUrl: updated.smsUrl,
    voiceUrl: updated.voiceUrl,
    statusCallback: updated.statusCallback,
  };
}

/**
 * Build a short-lived Voice AccessToken (JWT) for the in-browser softphone.
 * Uses the API Key SID/Secret; grants outgoing calls via the TwiML App and
 * incoming calls to the shared identity. Default TTL 1h.
 */
export async function generateVoiceToken(
  database: any,
  identity: string = 'superadmin',
  ttlSeconds: number = 3600,
): Promise<{ token: string; identity: string; ttl: number }> {
  const cfg = await getTwilioConfig(database);
  if (!cfg.accountSid) throw new Error('Twilio is not configured (missing Account SID).');
  if (!cfg.apiKeySid || !cfg.apiKeySecret) {
    throw new Error('Voice tokens require an API Key SID and Secret in Twilio settings.');
  }
  if (!cfg.twimlAppSid) {
    throw new Error('Voice tokens require a TwiML App SID in Twilio settings.');
  }

  const twilio = requireTwilio();
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(cfg.accountSid, cfg.apiKeySid, cfg.apiKeySecret, {
    identity,
    ttl: ttlSeconds,
  });
  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: cfg.twimlAppSid,
      incomingAllow: true,
    }),
  );

  return { token: token.toJwt(), identity, ttl: ttlSeconds };
}

/**
 * TwiML for an INBOUND PSTN call → ring the superadmin browser client.
 * <Response><Dial answerOnBridge="true"><Client>superadmin</Client></Dial></Response>
 */
export function buildIncomingCallTwiml(args: { clientIdentity?: string } = {}): string {
  const twilio = requireTwilio();
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const dial = response.dial({ answerOnBridge: true });
  dial.client(args.clientIdentity || 'superadmin');
  return response.toString();
}

/**
 * TwiML for a BROWSER-ORIGINATED outbound call → dial a PSTN number, presenting
 * the platform number as caller ID. This is the TwiML App's Voice URL handler.
 */
export function buildOutboundCallTwiml(args: { to: string; callerId: string }): string {
  const twilio = requireTwilio();
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  if (!args.to) {
    response.say('No destination number was provided.');
    return response.toString();
  }
  const dial = response.dial({ callerId: args.callerId, answerOnBridge: true });
  dial.number(args.to);
  return response.toString();
}

/**
 * Validate an inbound Twilio webhook's X-Twilio-Signature against the decrypted
 * authToken, the exact full public URL, and the posted form params.
 */
export function validateSignature(
  authToken: string,
  signatureHeader: string,
  fullUrl: string,
  params: Record<string, any>,
): boolean {
  if (!authToken) return false;
  try {
    const twilio = requireTwilio();
    return twilio.validateRequest(authToken, signatureHeader || '', fullUrl, params || {});
  } catch {
    return false;
  }
}

export default {
  publicWebhookBase,
  webhookUrls,
  getClient,
  sendSms,
  listIncomingNumbers,
  configureNumberWebhooks,
  generateVoiceToken,
  buildIncomingCallTwiml,
  buildOutboundCallTwiml,
  validateSignature,
};
