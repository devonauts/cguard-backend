/**
 * Stripe configuration service.
 *
 * Stripe keys can now be managed from the superadmin panel and are stored
 * (secrets encrypted) in platformSettings under key 'stripe', with separate
 * `test` and `live` blocks and an active `mode`. Everything resolves with an
 * ENV FALLBACK: if no key is saved for the active mode, the legacy
 * PLAN_STRIPE_* env vars are used — so existing behavior is unchanged until
 * keys are saved.
 *
 * - getStripeClient(database)      → a configured `stripe` client (or null)
 * - getStripeSecretKey(database)   → active secret key (db→env)
 * - getStripeWebhookSecret(database)
 * - getStripePriceId(database, plan)
 * - getStripeSettingsMasked(db)    → safe shape for the UI (secrets never returned)
 * - saveStripeSettings(req, body)  → upsert (only provided fields; blanks keep secrets)
 * - testStripeConnection(req, mode)→ verify a key actually works
 */
import { Request } from 'express';
import { getConfig } from '../../config';
import { encrypt, decrypt, last4 } from '../../lib/secretBox';
import { db, actor, writeAudit } from '../superadmin/superadminHelpers';

const KEY = 'stripe';
type Mode = 'test' | 'live';

interface ModeStored {
  publishableKey?: string;
  secretKey?: string; // encrypted at rest
  webhookSecret?: string; // encrypted at rest
  priceGrowth?: string;
  priceEnterprise?: string;
}
interface StripeStored {
  mode?: Mode;
  test?: ModeStored;
  live?: ModeStored;
  updatedAt?: string;
}

async function readStored(database: any): Promise<StripeStored> {
  try {
    const row = await database.platformSetting.findOne({ where: { key: KEY } });
    const v = row && row.value;
    return (v && typeof v === 'object' ? v : {}) as StripeStored;
  } catch {
    return {};
  }
}

async function writeStored(database: any, value: StripeStored, userId?: string): Promise<void> {
  const [row, created] = await database.platformSetting.findOrCreate({
    where: { key: KEY },
    defaults: { key: KEY, value, updatedByUserId: userId || null },
  });
  if (!created) await row.update({ value, updatedByUserId: userId || null });
}

export interface ResolvedStripe {
  mode: Mode;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  priceGrowth: string;
  priceEnterprise: string;
  source: 'db' | 'env';
}

/** Resolve the ACTIVE Stripe config (decrypted), falling back to env vars. */
export async function resolveStripe(database: any): Promise<ResolvedStripe> {
  const stored = await readStored(database);
  const mode: Mode = stored.mode === 'live' ? 'live' : 'test';
  const m: ModeStored = (stored[mode] || {}) as ModeStored;
  const dbSecret = decrypt(m.secretKey);

  if (dbSecret) {
    return {
      mode,
      secretKey: dbSecret,
      publishableKey: m.publishableKey || '',
      webhookSecret: decrypt(m.webhookSecret) || '',
      priceGrowth: m.priceGrowth || '',
      priceEnterprise: m.priceEnterprise || '',
      source: 'db',
    };
  }

  const cfg: any = getConfig();
  return {
    mode,
    secretKey: cfg.PLAN_STRIPE_SECRET_KEY || '',
    publishableKey: process.env.PLAN_STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: cfg.PLAN_STRIPE_WEBHOOK_SIGNING_SECRET || '',
    priceGrowth: cfg.PLAN_STRIPE_PRICES_GROWTH || '',
    priceEnterprise: cfg.PLAN_STRIPE_PRICES_ENTERPRISE || '',
    source: 'env',
  };
}

/** A configured Stripe client using the active secret key, or null if none. */
export async function getStripeClient(database: any): Promise<any | null> {
  const { secretKey } = await resolveStripe(database);
  if (!secretKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('stripe')(secretKey);
}

export async function getStripeSecretKey(database: any): Promise<string> {
  return (await resolveStripe(database)).secretKey;
}
export async function getStripeWebhookSecret(database: any): Promise<string> {
  return (await resolveStripe(database)).webhookSecret;
}
export async function getStripePriceId(database: any, plan: string): Promise<string> {
  const r = await resolveStripe(database);
  return /enterprise/i.test(plan) ? r.priceEnterprise : r.priceGrowth;
}

function maskMode(m: ModeStored = {}) {
  const secret = decrypt(m.secretKey);
  return {
    publishableKey: m.publishableKey || '',
    secretKeyConfigured: !!secret,
    secretKeyLast4: last4(secret),
    webhookSecretConfigured: !!decrypt(m.webhookSecret),
    priceGrowth: m.priceGrowth || null,
    priceEnterprise: m.priceEnterprise || null,
  };
}

/** Safe config for the panel UI — secrets are never returned in full. */
export async function getStripeSettingsMasked(database: any) {
  const stored = await readStored(database);
  const resolved = await resolveStripe(database);
  return {
    mode: (stored.mode === 'live' ? 'live' : 'test') as Mode,
    source: resolved.source,
    updatedAt: stored.updatedAt || null,
    test: maskMode(stored.test),
    live: maskMode(stored.live),
  };
}

export interface SaveStripeBody {
  mode?: Mode;
  test?: Partial<{ publishableKey: string; secretKey: string; webhookSecret: string; priceGrowth: string; priceEnterprise: string }>;
  live?: Partial<{ publishableKey: string; secretKey: string; webhookSecret: string; priceGrowth: string; priceEnterprise: string }>;
}

/** Upsert config. Only provided fields change; blank secret fields are ignored
 *  (so secrets are never wiped by an empty input). */
export async function saveStripeSettings(req: Request, body: SaveStripeBody) {
  const database = db(req);
  const stored = await readStored(database);
  const next: StripeStored = { ...stored };

  if (body.mode === 'test' || body.mode === 'live') next.mode = body.mode;

  (['test', 'live'] as Mode[]).forEach((mode) => {
    const incoming = body[mode];
    if (!incoming) return;
    const cur: ModeStored = { ...((next[mode] || {}) as ModeStored) };
    if (incoming.publishableKey !== undefined) cur.publishableKey = String(incoming.publishableKey || '').trim();
    if (incoming.priceGrowth !== undefined) cur.priceGrowth = String(incoming.priceGrowth || '').trim();
    if (incoming.priceEnterprise !== undefined) cur.priceEnterprise = String(incoming.priceEnterprise || '').trim();
    if (incoming.secretKey) cur.secretKey = encrypt(String(incoming.secretKey).trim()) || undefined;
    if (incoming.webhookSecret) cur.webhookSecret = encrypt(String(incoming.webhookSecret).trim()) || undefined;
    next[mode] = cur;
  });

  next.updatedAt = new Date().toISOString();
  await writeStored(database, next, actor(req).id);

  await writeAudit(req, {
    action: 'settings.stripe.update',
    targetType: 'platformSetting',
    targetId: 'stripe',
    statusCode: 200,
    details: {
      mode: next.mode,
      testSecretSet: !!(next.test && next.test.secretKey),
      liveSecretSet: !!(next.live && next.live.secretKey),
    },
  });

  return getStripeSettingsMasked(database);
}

/** Verify a saved key actually authenticates against Stripe. */
export async function testStripeConnection(
  req: Request,
  mode: Mode,
): Promise<{ ok: boolean; accountId?: string; livemode?: boolean; error?: string }> {
  const database = db(req);
  const stored = await readStored(database);
  const m: ModeStored = (stored[mode] || {}) as ModeStored;
  let secret = decrypt(m.secretKey);
  if (!secret) {
    // fall back to env (only meaningful if env holds this mode's key)
    secret = (getConfig() as any).PLAN_STRIPE_SECRET_KEY || '';
  }
  if (!secret) {
    return { ok: false, error: `No secret key configured for ${mode} mode.` };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stripe = require('stripe')(secret);
    const acct = await stripe.accounts.retrieve();
    return { ok: true, accountId: acct && acct.id, livemode: String(secret).startsWith('sk_live_') };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || 'Stripe authentication failed' };
  }
}
