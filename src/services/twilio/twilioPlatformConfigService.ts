/**
 * Platform Twilio configuration service.
 *
 * The platform phone center (SuperAdmin) uses ONE Twilio account/number for
 * SMS + in-browser voice. Connection config is managed from the superadmin
 * panel and stored (secrets encrypted) in platformSettings under key
 * 'twilioPlatform'. Everything resolves with an ENV FALLBACK so existing
 * env-based setups keep working until config is saved in the panel.
 *
 * Mirrors src/services/stripe/stripeConfigService.ts exactly in structure:
 * masked GET (last4 + configured flags, never raw secrets), write-only secrets,
 * env fallback, findOrCreate upsert, superAdminAuditLog audit entries.
 *
 * - getTwilioConfig(database)        → DECRYPTED resolved config (internal only)
 * - isTwilioConfigured(database)     → boolean (accountSid + authToken present)
 * - getTwilioSettingsMasked(db)      → safe shape for the UI (secrets never returned)
 * - saveTwilioSettings(req, body)    → upsert (blank secret fields keep secrets)
 * - testTwilioConnection(database)   → verify the saved creds authenticate
 */
import { Request } from 'express';
import { encrypt, decrypt, last4 } from '../../lib/secretBox';
import { db, actor, writeAudit } from '../superadmin/superadminHelpers';

const KEY = 'twilioPlatform';

interface TwilioStored {
  accountSid?: string;
  authToken?: string; // encrypted at rest (SECRET)
  apiKeySid?: string;
  apiKeySecret?: string; // encrypted at rest (SECRET)
  twimlAppSid?: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
  updatedAt?: string;
}

async function readStored(database: any): Promise<TwilioStored> {
  try {
    const row = await database.platformSetting.findOne({ where: { key: KEY } });
    const v = row && row.value;
    return (v && typeof v === 'object' ? v : {}) as TwilioStored;
  } catch {
    return {};
  }
}

async function writeStored(database: any, value: TwilioStored, userId?: string): Promise<void> {
  const [row, created] = await database.platformSetting.findOrCreate({
    where: { key: KEY },
    defaults: { key: KEY, value, updatedByUserId: userId || null },
  });
  if (!created) await row.update({ value, updatedByUserId: userId || null });
}

export interface ResolvedTwilio {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  phoneNumber: string;
  messagingServiceSid: string;
  source: 'db' | 'env';
}

/**
 * Resolve the platform Twilio config (DECRYPTED), falling back to env vars when
 * no account is saved in the panel. Internal use only — never return to the UI.
 */
export async function getTwilioConfig(database: any): Promise<ResolvedTwilio> {
  const stored = await readStored(database);
  const dbAccountSid = (stored.accountSid || '').trim();
  const dbAuthToken = decrypt(stored.authToken) || '';

  if (dbAccountSid && dbAuthToken) {
    return {
      accountSid: dbAccountSid,
      authToken: dbAuthToken,
      apiKeySid: (stored.apiKeySid || '').trim(),
      apiKeySecret: decrypt(stored.apiKeySecret) || '',
      twimlAppSid: (stored.twimlAppSid || '').trim(),
      phoneNumber: (stored.phoneNumber || '').trim(),
      messagingServiceSid: (stored.messagingServiceSid || '').trim(),
      source: 'db',
    };
  }

  return {
    accountSid: process.env.TWILIO_MASTER_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_MASTER_AUTH_TOKEN || '',
    apiKeySid: process.env.TWILIO_API_KEY_SID || '',
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || '',
    phoneNumber: process.env.TWILIO_FROM_NUMBER || '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
    source: 'env',
  };
}

/** True when we have at least an accountSid + authToken to talk to Twilio. */
export async function isTwilioConfigured(database: any): Promise<boolean> {
  const c = await getTwilioConfig(database);
  return !!(c.accountSid && c.authToken);
}

/** Safe config for the panel UI — secrets are never returned in full. */
export async function getTwilioSettingsMasked(database: any) {
  const stored = await readStored(database);
  const resolved = await getTwilioConfig(database);
  const authToken = decrypt(stored.authToken);
  const apiKeySecret = decrypt(stored.apiKeySecret);
  return {
    source: resolved.source,
    configured: !!(resolved.accountSid && resolved.authToken),
    updatedAt: stored.updatedAt || null,
    accountSid: stored.accountSid || (resolved.source === 'env' ? resolved.accountSid : '') || '',
    apiKeySid: stored.apiKeySid || (resolved.source === 'env' ? resolved.apiKeySid : '') || '',
    twimlAppSid: stored.twimlAppSid || (resolved.source === 'env' ? resolved.twimlAppSid : '') || '',
    phoneNumber: stored.phoneNumber || (resolved.source === 'env' ? resolved.phoneNumber : '') || '',
    messagingServiceSid:
      stored.messagingServiceSid || (resolved.source === 'env' ? resolved.messagingServiceSid : '') || '',
    authTokenConfigured: !!authToken || (resolved.source === 'env' && !!resolved.authToken),
    authTokenLast4: last4(authToken),
    apiKeySecretConfigured: !!apiKeySecret || (resolved.source === 'env' && !!resolved.apiKeySecret),
    apiKeySecretLast4: last4(apiKeySecret),
  };
}

export interface SaveTwilioBody {
  accountSid?: string;
  authToken?: string; // SECRET — blank keeps existing
  apiKeySid?: string;
  apiKeySecret?: string; // SECRET — blank keeps existing
  twimlAppSid?: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
}

/**
 * Upsert platform Twilio config. Only provided fields change; blank secret
 * fields are ignored (so secrets are never wiped by an empty input).
 */
export async function saveTwilioSettings(req: Request, body: SaveTwilioBody) {
  const database = db(req);
  const stored = await readStored(database);
  const next: TwilioStored = { ...stored };

  if (body.accountSid !== undefined) next.accountSid = String(body.accountSid || '').trim();
  if (body.apiKeySid !== undefined) next.apiKeySid = String(body.apiKeySid || '').trim();
  if (body.twimlAppSid !== undefined) next.twimlAppSid = String(body.twimlAppSid || '').trim();
  if (body.phoneNumber !== undefined) next.phoneNumber = String(body.phoneNumber || '').trim();
  if (body.messagingServiceSid !== undefined)
    next.messagingServiceSid = String(body.messagingServiceSid || '').trim();

  // Secrets: only overwrite when a non-empty value is supplied.
  if (body.authToken) next.authToken = encrypt(String(body.authToken).trim()) || undefined;
  if (body.apiKeySecret) next.apiKeySecret = encrypt(String(body.apiKeySecret).trim()) || undefined;

  next.updatedAt = new Date().toISOString();
  await writeStored(database, next, actor(req).id);

  await writeAudit(req, {
    action: 'settings.twilio.update',
    targetType: 'platformSetting',
    targetId: 'twilioPlatform',
    statusCode: 200,
    details: {
      accountSidSet: !!next.accountSid,
      authTokenSet: !!next.authToken,
      apiKeySet: !!(next.apiKeySid && next.apiKeySecret),
      twimlAppSet: !!next.twimlAppSid,
      phoneNumberSet: !!next.phoneNumber,
    },
  });

  return getTwilioSettingsMasked(database);
}

/** Verify the saved (or env) credentials actually authenticate against Twilio. */
export async function testTwilioConnection(
  database: any,
): Promise<{ ok: boolean; accountSid?: string; friendlyName?: string; status?: string; error?: string }> {
  const cfg = await getTwilioConfig(database);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: 'No Twilio Account SID / Auth Token configured.' };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(cfg.accountSid, cfg.authToken);
    const acct = await client.api.accounts(cfg.accountSid).fetch();
    return {
      ok: true,
      accountSid: acct && acct.sid,
      friendlyName: acct && acct.friendlyName,
      status: acct && acct.status,
    };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || 'Twilio authentication failed' };
  }
}

export default {
  getTwilioConfig,
  isTwilioConfigured,
  getTwilioSettingsMasked,
  saveTwilioSettings,
  testTwilioConnection,
};
