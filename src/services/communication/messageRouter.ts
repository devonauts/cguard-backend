/**
 * messageRouter — turns a high-level MessageIntent into per-channel send
 * attempts following the routing rules, logging EVERY attempt to
 * communicationLogs and wallet-gating paid channels (whatsapp/sms).
 *
 * Channel order (free → paid): PUSH first, then WhatsApp (Meta), then SMS
 * (Twilio fallback only), then Email if asked. The router — not the providers —
 * owns:
 *   - recipient resolution (userId → push tokens / phone / email),
 *   - channel selection + ordering per messageType (the routing rules below),
 *   - the per-tenant wallet gate (skip + log 'skipped' on insufficient balance),
 *   - the wallet debit after a successful paid send,
 *   - logging every single attempt to communicationLogs.
 *
 * ROUTING RULES (per the contract):
 *  - Non-critical operational: push → whatsapp (if enabled+wallet) → sms (only if
 *    important+enabled+wallet). Stop at first success.
 *  - Critical: push + whatsapp (fan out, don't stop). panic/emergency → also sms.
 *  - OTP: whatsapp AUTHENTICATION template (if otp_preferred_channel='whatsapp'
 *    and enabled) else sms. NEVER free-form WhatsApp text for OTP.
 *  - Visitor: push first; whatsapp only if tenant enables it; sms only if tenant
 *    enables the critical sms fallback.
 *  - Shift reminder: push first; whatsapp if guard has no push token OR tenant
 *    enables whatsapp reminders; sms only fallback.
 *  - Incident: push + whatsapp to supervisors/admins (caller targets recipient).
 *  - Ronda missed checkpoint: push + whatsapp; sms only if sms_critical.
 *  - Wallet: before a paid send, if wallet_required_for_paid_channels and balance
 *    insufficient and not (critical && allow_negative) → SKIP + LOG 'skipped'.
 *    Push/email are never wallet-blocked.
 *  - Invalid/missing push token → provider marks token inactive; the router only
 *    falls back to other channels when a rule says so (it always does here because
 *    push 'skipped' simply means "try the next channel in the plan").
 */
import {
  Channel,
  CommunicationProvider,
  CommunicationSettings,
  MessageIntent,
  MessageType,
  OutboundMessage,
  SendResult,
} from './types';
import { pushProvider } from './providers/pushProvider';
import { metaWhatsAppProvider } from './providers/metaWhatsAppProvider';
import { twilioSmsProvider } from './providers/twilioSmsProvider';
import { emailProvider } from './providers/emailProvider';
import * as logService from './communicationLogService';
import {
  getSettings,
  isChannelEnabled,
  getWallet,
  debitWallet,
  estimateCost,
} from './communicationSettingsService';
import { normalizeToE164 } from './phone';
import { getUserDeviceRows } from '../pushService';

const PROVIDERS: Record<Channel, CommunicationProvider> = {
  push: pushProvider,
  whatsapp: metaWhatsAppProvider,
  sms: twilioSmsProvider,
  email: emailProvider,
};

/** Channels considered "paid" — wallet-gated before send. */
const PAID_CHANNELS: Channel[] = ['whatsapp', 'sms'];

/** Default WhatsApp template name per messageType (global whatsappTemplates seeds). */
const TEMPLATE_BY_TYPE: Partial<Record<MessageType, string>> = {
  otp: 'otp_code',
  shift_reminder: 'shift_reminder',
  new_assignment: 'new_assignment',
  incident_alert: 'incident_alert',
  ronda_alert: 'missed_checkpoint',
  no_show: 'no_show_alert',
  visitor_alert: 'visitor_arrived',
  task_alert: 'task_assigned',
  panic: 'panic_alert',
};

// ---------------------------------------------------------------------------
// Recipient resolution (userId → push target / phone / email)
// ---------------------------------------------------------------------------

interface ResolvedRecipients {
  /** userId for the push provider (token-resolved downstream). */
  pushUserId: string | null;
  /** The user's device rows, resolved ONCE per route() and threaded to the push
   *  provider so neither it nor its pushToUser fallback re-queries them. */
  deviceRows: any[];
  /** Whether the user currently has at least one active push token. */
  hasPushToken: boolean;
  /** E.164 phone for whatsapp/sms. */
  phone: string | null;
  /** Email address for the email channel. */
  email: string | null;
}

/** Look up a user's phone + email from the users table (best-effort). */
async function loadUserContact(
  db: any,
  userId: string,
): Promise<{ phone: string | null; email: string | null }> {
  try {
    const row = await db.user.findByPk(userId);
    if (!row) return { phone: null, email: null };
    const p = row.get ? row.get({ plain: true }) : row;
    return { phone: p.phoneNumber || null, email: p.email || null };
  } catch {
    return { phone: null, email: null };
  }
}

/**
 * Resolve all recipient handles for an intent. Explicit intent.phone/email always
 * win; otherwise we derive them from intent.userId. Phones are E.164-normalized
 * with the tenant's default country code so downstream providers compare equal.
 */
async function resolveRecipients(
  db: any,
  intent: MessageIntent,
  settings: CommunicationSettings,
): Promise<ResolvedRecipients> {
  const pushUserId = intent.userId || null;
  let phone = intent.phone || null;
  let email = intent.email || null;

  if (intent.userId && (!phone || !email)) {
    const contact = await loadUserContact(db, intent.userId);
    if (!phone) phone = contact.phone;
    if (!email) email = contact.email;
  }

  const normalizedPhone = phone
    ? normalizeToE164(phone, settings.default_country_code)
    : null;

  // Resolve device rows ONCE: they drive both the shift-reminder rule
  // (hasPushToken) and the actual push send downstream.
  const deviceRows = intent.userId
    ? await getUserDeviceRows(db, intent.tenantId, intent.userId)
    : [];
  const hasPushToken = deviceRows.some((r: any) => !!(r.pushToken || r.deviceId));

  return { pushUserId, deviceRows, hasPushToken, phone: normalizedPhone, email };
}

// ---------------------------------------------------------------------------
// Channel plan (the routing rules)
// ---------------------------------------------------------------------------

/**
 * Decide which channels to attempt, in order, for an intent. An explicit
 * intent.channels override short-circuits the rules (used by the facade's
 * low-level single-channel helpers like sendPushNotification/sendSms).
 *
 * The plan is filtered later by enable + configured + recipient availability;
 * here we only encode the rule-level intent of WHICH channels apply.
 */
function buildChannelPlan(
  intent: MessageIntent,
  settings: CommunicationSettings,
  recipients: ResolvedRecipients,
): Channel[] {
  if (intent.channels && intent.channels.length) return dedupe(intent.channels);

  const critical = !!intent.critical;
  const plan: Channel[] = [];

  switch (intent.messageType) {
    case 'otp': {
      // OTP: WhatsApp AUTHENTICATION template first if preferred + enabled, else
      // SMS. Never push (OTP must be a verifiable channel), never free-form WA.
      if (settings.otp_preferred_channel === 'whatsapp' && settings.whatsapp_enabled) {
        plan.push('whatsapp', 'sms');
      } else {
        plan.push('sms', 'whatsapp');
      }
      break;
    }

    case 'panic': {
      // Emergency: every reachable channel immediately.
      plan.push('push', 'whatsapp', 'sms');
      break;
    }

    case 'incident_alert':
    case 'escalation': {
      // Push + WhatsApp to supervisors/admins (incidents go to WA per the rules).
      // SMS only when critical and the tenant's critical-sms fallback is on.
      plan.push('push', 'whatsapp');
      if (critical && settings.critical_alert_sms_fallback) plan.push('sms');
      break;
    }

    case 'visitor_alert': {
      // Push first; WhatsApp optional per setting; SMS only if sms fallback on.
      plan.push('push');
      if (settings.whatsapp_incidents) plan.push('whatsapp');
      if (settings.critical_alert_sms_fallback && settings.sms_critical) plan.push('sms');
      break;
    }

    case 'shift_reminder': {
      // Push first; WhatsApp if guard has no push token OR tenant enables WA
      // reminders; SMS only as a last-ditch fallback.
      plan.push('push');
      if (settings.whatsapp_shift_reminders || !recipients.hasPushToken) plan.push('whatsapp');
      if (critical) plan.push('sms');
      break;
    }

    case 'ronda_alert': {
      // Missed checkpoint: push + WhatsApp to supervisor; SMS only if sms_critical.
      plan.push('push', 'whatsapp');
      if (settings.sms_critical && (critical || settings.critical_alert_sms_fallback)) {
        plan.push('sms');
      }
      break;
    }

    case 'no_show':
    case 'new_assignment':
    case 'task_alert':
    case 'generic':
    default: {
      // Generic operational: push → whatsapp → (sms only if important/critical).
      plan.push('push', 'whatsapp');
      if (critical && settings.critical_alert_sms_fallback) plan.push('sms');
      break;
    }
  }

  // Email is opt-in only via explicit intent.channels or when nothing else can be
  // attempted but an email recipient exists — it's never auto-added to the
  // operational cascade here.
  return dedupe(plan);
}

function dedupe(channels: Channel[]): Channel[] {
  const seen = new Set<Channel>();
  const out: Channel[] = [];
  for (const c of channels) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

/** Build the per-channel OutboundMessage for an intent + resolved recipients. */
function buildMessage(
  intent: MessageIntent,
  channel: Channel,
  recipients: ResolvedRecipients,
): OutboundMessage {
  let recipient = '';
  if (channel === 'push') recipient = recipients.pushUserId || '';
  else if (channel === 'email') recipient = recipients.email || '';
  else recipient = recipients.phone || ''; // whatsapp / sms

  // For WhatsApp, attach a default template name when the intent didn't supply
  // one (so business-initiated messages don't depend on the 24h window).
  let templateName = intent.templateName;
  if (channel === 'whatsapp' && !templateName) {
    templateName = TEMPLATE_BY_TYPE[intent.messageType];
  }

  return {
    tenantId: intent.tenantId,
    userId: intent.userId,
    recipient,
    channel,
    messageType: intent.messageType,
    title: intent.title,
    body: intent.body,
    templateName: channel === 'whatsapp' ? templateName : intent.templateName,
    templateVars: intent.templateVars,
    languageCode: intent.languageCode,
    deepLink: intent.deepLink,
    data: intent.data,
    critical: intent.critical,
  };
}

/** A channel can only be attempted if it has a recipient handle. */
function hasRecipient(channel: Channel, recipients: ResolvedRecipients): boolean {
  if (channel === 'push') return !!recipients.pushUserId;
  if (channel === 'email') return !!recipients.email;
  return !!recipients.phone; // whatsapp / sms
}

// ---------------------------------------------------------------------------
// Per-channel attempt (enable → configured → wallet → send → debit → log)
// ---------------------------------------------------------------------------

async function attemptChannel(
  db: any,
  intent: MessageIntent,
  channel: Channel,
  settings: CommunicationSettings,
  recipients: ResolvedRecipients,
): Promise<SendResult> {
  const provider = PROVIDERS[channel];
  const msg = buildMessage(intent, channel, recipients);

  // 0) No recipient handle → skip (don't even hit the provider).
  if (!hasRecipient(channel, recipients)) {
    const r: SendResult = {
      status: 'skipped',
      channel,
      provider: provider?.channel,
      skipReason: channel === 'push' ? 'no_user' : 'no_recipient',
    };
    await logAttempt(db, intent, channel, msg, r);
    return r;
  }

  // 1) Tenant toggle.
  if (!(await isChannelEnabled(db, intent.tenantId, channel, settings))) {
    const r: SendResult = { status: 'skipped', channel, skipReason: 'channel_disabled' };
    await logAttempt(db, intent, channel, msg, r);
    return r;
  }

  // 2) Provider configured?
  const configured = await provider.isConfigured(db, intent.tenantId).catch(() => false);
  if (!configured) {
    const r: SendResult = { status: 'skipped', channel, skipReason: 'not_configured' };
    await logAttempt(db, intent, channel, msg, r);
    return r;
  }

  // 3) Wallet gate for paid channels.
  let estimateCents = 0;
  if (PAID_CHANNELS.includes(channel)) {
    const country = settings.default_country_code;
    const est = await estimateCost(
      db,
      channel === 'whatsapp' ? 'meta' : 'twilio',
      channel,
      country,
      intent.messageType,
    );
    estimateCents = est.costCents;

    if (settings.wallet_required_for_paid_channels) {
      const wallet = await getWallet(db, intent.tenantId);
      const allowOverride = !!intent.critical && !!settings.allow_negative_communications_balance;
      if (wallet.balanceCents < estimateCents && !allowOverride) {
        const r: SendResult = {
          status: 'skipped',
          channel,
          skipReason: 'insufficient_balance',
          costEstimateCents: estimateCents,
        };
        await logAttempt(db, intent, channel, msg, r);
        return r;
      }
    }
  }

  // 4) Send. Push gets the pre-resolved device rows (resolved once in
  //    resolveRecipients) so the provider doesn't re-query them.
  let result: SendResult;
  try {
    result = channel === 'push'
      ? await pushProvider.send(db, msg, recipients.deviceRows)
      : await provider.send(db, msg);
  } catch (e: any) {
    result = { status: 'failed', channel, error: e?.message || String(e) };
  }
  if (estimateCents && result.costEstimateCents == null) result.costEstimateCents = estimateCents;

  // 5) Debit wallet on a successful paid send (router owns the debit so billing +
  //    logging stay in one place; providers must NOT debit).
  if (PAID_CHANNELS.includes(channel) && (result.status === 'sent' || result.status === 'delivered')) {
    const billed = result.costEstimateCents ?? estimateCents;
    if (billed > 0) {
      const allowNeg = !!intent.critical;
      const deb = await debitWallet(db, intent.tenantId, billed, result.providerMessageId, {
        allowNegative: allowNeg,
      }).catch(() => null);
      if (deb && deb.ok) result.billedAmountCents = billed;
    }
  }

  await logAttempt(db, intent, channel, msg, result);
  return result;
}

async function logAttempt(
  db: any,
  intent: MessageIntent,
  channel: Channel,
  msg: OutboundMessage,
  result: SendResult,
): Promise<void> {
  await logService.log(db, {
    tenantId: intent.tenantId,
    userId: intent.userId || null,
    recipient: msg.recipient || null,
    channel,
    provider: result.provider || null,
    messageType: intent.messageType,
    status: result.status,
    providerMessageId: result.providerMessageId || null,
    providerResponse: result.providerResponse ?? null,
    errorMessage: result.error || result.skipReason || null,
    costEstimateCents: result.costEstimateCents ?? null,
    billedAmountCents: result.billedAmountCents ?? null,
    deepLink: msg.deepLink || null,
  });
}

// ---------------------------------------------------------------------------
// route() — apply the plan + cascade semantics
// ---------------------------------------------------------------------------

function isSuccess(r: SendResult): boolean {
  return r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
}

/**
 * Should the cascade stop after this channel succeeded?
 *
 *  - Non-critical operational: stop at the first delivered channel (push wins,
 *    we don't also pay for WhatsApp/SMS).
 *  - OTP: stop at the first delivered channel (one code, one channel).
 *  - Critical (incident/escalation/panic/etc.): fan out — push AND WhatsApp (and
 *    SMS for panic) all fire so a supervisor is reached on every channel.
 */
function stopAfterSuccess(intent: MessageIntent): boolean {
  if (intent.messageType === 'otp') return true;
  return !intent.critical;
}

/**
 * Route an intent across channels per the rules. Returns one SendResult per
 * channel attempted (in attempt order). Always logs every attempt.
 */
export async function route(db: any, intent: MessageIntent): Promise<SendResult[]> {
  const settings = await getSettings(db, intent.tenantId);
  const recipients = await resolveRecipients(db, intent, settings);
  const plan = buildChannelPlan(intent, settings, recipients);

  const results: SendResult[] = [];
  const stopOnSuccess = stopAfterSuccess(intent);

  for (const channel of plan) {
    const r = await attemptChannel(db, intent, channel, settings, recipients);
    results.push(r);
    if (isSuccess(r) && stopOnSuccess) break;
  }

  return results;
}

export default { route };
