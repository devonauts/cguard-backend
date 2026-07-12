/**
 * communicationSettingsService — per-tenant communication config + wallet +
 * pricing + Meta credentials.
 *
 * Settings live as a JSON blob on settings.communicationSettings (settings PK =
 * tenantId). getSettings() merges stored values over DEFAULTS. Wallet rows live
 * in communicationWallets (one per tenant); debit/credit are atomic (row lock +
 * transaction) and refuse to go negative unless allow_negative is set. Cost
 * estimation reads communicationProviderRates (most-specific match + markup).
 * Meta credentials mirror stripeConfigService: encrypted in platformSettings
 * under key 'whatsapp', with env fallback to META_WHATSAPP_*.
 */
import { encrypt, decrypt, last4 } from '../../lib/secretBox';
import { Channel, CommunicationSettings, MetaConfig } from './types';

export const DEFAULT_SETTINGS: CommunicationSettings = {
  push_enabled: true,
  whatsapp_enabled: false,
  sms_enabled: false,
  email_enabled: true,
  whatsapp_provider: 'meta',
  sms_provider: 'twilio',
  critical_alert_sms_fallback: true,
  otp_preferred_channel: 'whatsapp',
  wallet_required_for_paid_channels: true,
  low_balance_threshold: 500,
  allow_negative_communications_balance: false,
  default_country_code: '+593',
  timezone: null,
  whatsapp_shift_reminders: false,
  whatsapp_incidents: true,
  sms_critical: true,
};

const META_KEY = 'whatsapp';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Read the tenant's settings row (PK = tenantId). */
async function settingsRow(db: any, tenantId: string): Promise<any | null> {
  try {
    return await db.settings.findByPk(tenantId);
  } catch {
    return null;
  }
}

/** Merged communication settings for a tenant (DEFAULTS ← stored overrides). */
export async function getSettings(db: any, tenantId: string): Promise<CommunicationSettings> {
  const row = await settingsRow(db, tenantId);
  let stored: any = {};
  if (row) {
    const raw = row.communicationSettings; // model getter parses JSON → object
    stored = raw && typeof raw === 'object' ? raw : {};
  }
  return { ...DEFAULT_SETTINGS, ...stored } as CommunicationSettings;
}

/** Persist a partial settings patch (merged over existing). Returns merged. */
export async function saveSettings(
  db: any,
  tenantId: string,
  patch: Partial<CommunicationSettings>,
): Promise<CommunicationSettings> {
  const [row] = await db.settings.findOrCreate({
    where: { id: tenantId },
    defaults: { id: tenantId, tenantId, theme: 'default' },
  });
  const current = (row.communicationSettings && typeof row.communicationSettings === 'object'
    ? row.communicationSettings
    : {}) as any;
  const merged = { ...current, ...(patch || {}) };
  await row.update({ communicationSettings: merged });
  return { ...DEFAULT_SETTINGS, ...merged } as CommunicationSettings;
}

/** Is a channel enabled for the tenant per its settings? */
export async function isChannelEnabled(
  db: any,
  tenantId: string,
  channel: Channel,
  settings?: CommunicationSettings,
): Promise<boolean> {
  const s = settings || (await getSettings(db, tenantId));
  switch (channel) {
    case 'push':
      return s.push_enabled !== false;
    case 'whatsapp':
      return !!s.whatsapp_enabled;
    case 'sms':
      return !!s.sms_enabled;
    case 'email':
      return s.email_enabled !== false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet (communicationWallets)
// ---------------------------------------------------------------------------

export interface WalletSnapshot {
  balanceCents: number;
  currency: string;
  lowBalanceThresholdCents: number;
  belowThreshold: boolean;
}

async function ensureWallet(db: any, tenantId: string, transaction?: any): Promise<any> {
  const [row] = await db.communicationWallet.findOrCreate({
    where: { tenantId },
    defaults: { tenantId, balanceCents: 0, currency: 'USD', lowBalanceThresholdCents: 500 },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  return row;
}

export async function getWallet(db: any, tenantId: string): Promise<WalletSnapshot> {
  const row = await ensureWallet(db, tenantId);
  const p = row.get ? row.get({ plain: true }) : row;
  const balanceCents = p.balanceCents || 0;
  const lowBalanceThresholdCents = p.lowBalanceThresholdCents ?? 500;
  return {
    balanceCents,
    currency: p.currency || 'USD',
    lowBalanceThresholdCents,
    belowThreshold: balanceCents < lowBalanceThresholdCents,
  };
}

export interface WalletMoveResult {
  ok: boolean;
  balanceAfterCents: number;
  reason?: string;
}

/**
 * Atomically debit the wallet. Refuses (ok=false) when balance is insufficient,
 * UNLESS opts.allowNegative (or the tenant's allow_negative_communications_balance)
 * is set. `ref` is stored on the providerResponse trail by callers; the wallet
 * itself only tracks balance here (the communicationLog is the ledger).
 */
export async function debitWallet(
  db: any,
  tenantId: string,
  cents: number,
  ref?: string,
  opts: { allowNegative?: boolean } = {},
): Promise<WalletMoveResult> {
  if (!(cents > 0)) return { ok: true, balanceAfterCents: (await getWallet(db, tenantId)).balanceCents };

  let allowNegative = !!opts.allowNegative;
  if (!allowNegative) {
    const s = await getSettings(db, tenantId);
    allowNegative = !!s.allow_negative_communications_balance;
  }

  const t = await db.sequelize.transaction();
  try {
    const row = await ensureWallet(db, tenantId, t);
    const balance = row.balanceCents || 0;
    if (balance < cents && !allowNegative) {
      await t.commit();
      return { ok: false, balanceAfterCents: balance, reason: 'insufficient_balance' };
    }
    const balanceAfter = balance - cents;
    await row.update({ balanceCents: balanceAfter }, { transaction: t });
    await t.commit();
    return { ok: true, balanceAfterCents: balanceAfter };
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

/**
 * Idempotent recharge credit (safe under Stripe webhook retries): dedupes by a
 * channel='wallet' ledger row in communicationLogs keyed on
 * providerMessageId=reference (the checkout session id). The log row doubles
 * as the visible ledger entry in the Comunicaciones log.
 *
 * RACE-SAFETY: the wallet row lock (ensureWallet with FOR UPDATE) is taken
 * FIRST, then the dedupe findOne runs inside the same transaction. The row
 * lock serializes concurrent same-tenant credits (e.g. a webhook retry racing
 * the reconciliation sweep), so the second writer only checks the dedupe row
 * AFTER the first has committed it — no double-credit window.
 */
export async function creditWalletFromRecharge(
  db: any,
  tenantId: string,
  cents: number,
  opts: { reference: string; description?: string; currency?: string },
): Promise<WalletMoveResult & { duplicated?: boolean }> {
  if (!(cents > 0)) {
    throw Object.assign(new Error('cents must be positive'), { code: 400 });
  }
  const t = await db.sequelize.transaction();
  try {
    // Lock the wallet row BEFORE the dedupe check (see RACE-SAFETY above).
    const row = await ensureWallet(db, tenantId, t);
    if (opts.reference) {
      const existing = await db.communicationLog.findOne({
        where: { tenantId, channel: 'wallet', providerMessageId: opts.reference },
        transaction: t,
      });
      if (existing) {
        await t.commit();
        return { ok: true, balanceAfterCents: row.balanceCents || 0, duplicated: true };
      }
    }
    const balanceAfter = (row.balanceCents || 0) + cents;
    await row.update({ balanceCents: balanceAfter }, { transaction: t });
    // Ledger entry. billedAmountCents is negative so period sums stay
    // meaningful next to the positive debit rows the router logs on sends.
    await db.communicationLog.create(
      {
        tenantId,
        channel: 'wallet',
        provider: 'stripe',
        messageType: 'wallet_recharge',
        status: 'delivered',
        providerMessageId: opts.reference || null,
        billedAmountCents: -cents,
        currency: (opts.currency || 'USD').toUpperCase(),
        providerResponse: {
          description: opts.description || 'Recarga de saldo de comunicaciones',
          creditedCents: cents,
          balanceAfterCents: balanceAfter,
        },
      },
      { transaction: t },
    );
    await t.commit();
    return { ok: true, balanceAfterCents: balanceAfter };
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

/** Atomically credit the wallet (recharge / refund). */
export async function creditWallet(
  db: any,
  tenantId: string,
  cents: number,
  _ref?: string,
): Promise<WalletMoveResult> {
  if (!(cents > 0)) return { ok: true, balanceAfterCents: (await getWallet(db, tenantId)).balanceCents };
  const t = await db.sequelize.transaction();
  try {
    const row = await ensureWallet(db, tenantId, t);
    const balanceAfter = (row.balanceCents || 0) + cents;
    await row.update({ balanceCents: balanceAfter }, { transaction: t });
    await t.commit();
    return { ok: true, balanceAfterCents: balanceAfter };
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cost estimation (communicationProviderRates)
// ---------------------------------------------------------------------------

export interface CostEstimate {
  costCents: number; // billed amount (pass-through + markup)
  baseCostCents: number; // provider pass-through
  markupPercentage: number;
  currency: string;
  matched: boolean;
}

/**
 * Estimate the billed cost of a send (SMS rates are PER SEGMENT — callers
 * multiply by the segment count from smsText.toSmsBody).
 *
 * `countryOrRecipient` accepts either a bare country code ('+593') or a FULL
 * E.164 recipient ('+593983212345') — rates are resolved by LONGEST-PREFIX
 * match of rate.countryCode against the recipient, so pricing follows the
 * DESTINATION of the message, not the tenant's default country. Rows with a
 * NULL countryCode are wildcards. Exact messageType beats the type wildcard,
 * but a longer country prefix always beats a shorter one.
 *
 * Returns matched:false (0-cost) when no rate row exists — PAID channels must
 * NOT treat that as free (the router applies a hardcoded floor instead).
 */
export async function estimateCost(
  db: any,
  provider: string,
  channel: Channel,
  countryOrRecipient?: string | null,
  messageType?: string | null,
): Promise<CostEstimate> {
  try {
    const rows = await db.communicationProviderRate.findAll({
      where: { provider, channel, active: true },
    });
    const list = rows.map((r: any) => (r.get ? r.get({ plain: true }) : r));

    // Canonical '+<digits>' target for prefix matching (the table is tiny, so
    // candidate rows are fetched for provider+channel and matched in JS).
    const targetDigits = countryOrRecipient
      ? String(countryOrRecipient).replace(/\D/g, '')
      : '';
    const target = targetDigits ? `+${targetDigits}` : null;

    // Score: country prefix length dominates (×10) so '+593' beats '+5' and a
    // longer prefix always beats an exact-messageType wildcard-country row;
    // exact messageType (+1) breaks ties. Reject rows where a non-null field
    // doesn't match.
    let best: any = null;
    let bestScore = -1;
    for (const r of list) {
      let score = 0;
      if (r.countryCode != null) {
        const cc = `+${String(r.countryCode).replace(/\D/g, '')}`;
        if (target && cc.length > 1 && target.startsWith(cc)) score += 100 + cc.length * 10;
        else continue;
      }
      if (r.messageType != null) {
        if (messageType && String(r.messageType) === String(messageType)) score += 1;
        else continue;
      }
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    if (!best) {
      return { costCents: 0, baseCostCents: 0, markupPercentage: 0, currency: 'USD', matched: false };
    }
    const base = Number(best.costCents) || 0;
    const markup = Number(best.markupPercentage) || 0;
    const billed = Math.round(base * (1 + markup / 100));
    return {
      costCents: billed,
      baseCostCents: base,
      markupPercentage: markup,
      currency: best.currency || 'USD',
      matched: true,
    };
  } catch (e: any) {
    console.warn('[communicationSettings] estimateCost failed:', e?.message || e);
    return { costCents: 0, baseCostCents: 0, markupPercentage: 0, currency: 'USD', matched: false };
  }
}

// ---------------------------------------------------------------------------
// Meta WhatsApp credentials (platformSettings key 'whatsapp', env fallback)
// ---------------------------------------------------------------------------

interface MetaStored {
  accessToken?: string; // encrypted
  phoneNumberId?: string;
  businessAccountId?: string;
  apiVersion?: string;
  webhookVerifyToken?: string; // encrypted
  appSecret?: string; // encrypted
  updatedAt?: string;
}

async function readMetaStored(db: any): Promise<MetaStored> {
  try {
    const row = await db.platformSetting.findOne({ where: { key: META_KEY } });
    const v = row && row.value;
    return (v && typeof v === 'object' ? v : {}) as MetaStored;
  } catch {
    return {};
  }
}

/** Resolved Meta credentials (decrypted), falling back to env vars. */
export async function getMetaConfig(db: any): Promise<MetaConfig> {
  const stored = await readMetaStored(db);
  const dbToken = decrypt(stored.accessToken);
  const apiVersion =
    stored.apiVersion || process.env.META_WHATSAPP_API_VERSION || 'v20.0';

  if (dbToken) {
    return {
      accessToken: dbToken,
      phoneNumberId: stored.phoneNumberId || process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
      businessAccountId:
        stored.businessAccountId || process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      apiVersion,
      webhookVerifyToken:
        decrypt(stored.webhookVerifyToken) || process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
      appSecret: decrypt(stored.appSecret) || process.env.META_APP_SECRET || '',
      source: 'db',
    };
  }

  return {
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    apiVersion,
    webhookVerifyToken: process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    appSecret: process.env.META_APP_SECRET || '',
    source: 'env',
  };
}

/** True when Meta WhatsApp is usable (token + phone number id present). */
export async function isMetaConfigured(db: any): Promise<boolean> {
  const c = await getMetaConfig(db);
  return !!(c.accessToken && c.phoneNumberId);
}

/** Safe, masked Meta config for the panel UI (secrets never returned in full). */
export async function getMetaConfigMasked(db: any) {
  const stored = await readMetaStored(db);
  const resolved = await getMetaConfig(db);
  return {
    source: resolved.source,
    apiVersion: resolved.apiVersion,
    phoneNumberId: resolved.phoneNumberId || null,
    businessAccountId: resolved.businessAccountId || null,
    accessTokenConfigured: !!resolved.accessToken,
    accessTokenLast4: last4(resolved.accessToken),
    webhookVerifyTokenConfigured: !!resolved.webhookVerifyToken,
    appSecretConfigured: !!resolved.appSecret,
    updatedAt: stored.updatedAt || null,
  };
}

/** Upsert Meta config; blank secret fields are ignored (secrets never wiped). */
export async function saveMetaConfig(
  db: any,
  body: Partial<{
    accessToken: string;
    phoneNumberId: string;
    businessAccountId: string;
    apiVersion: string;
    webhookVerifyToken: string;
    appSecret: string;
  }>,
  userId?: string,
) {
  const stored = await readMetaStored(db);
  const next: MetaStored = { ...stored };
  if (body.phoneNumberId !== undefined) next.phoneNumberId = String(body.phoneNumberId || '').trim();
  if (body.businessAccountId !== undefined)
    next.businessAccountId = String(body.businessAccountId || '').trim();
  if (body.apiVersion !== undefined) next.apiVersion = String(body.apiVersion || '').trim();
  if (body.accessToken) next.accessToken = encrypt(String(body.accessToken).trim()) || undefined;
  if (body.webhookVerifyToken)
    next.webhookVerifyToken = encrypt(String(body.webhookVerifyToken).trim()) || undefined;
  if (body.appSecret) next.appSecret = encrypt(String(body.appSecret).trim()) || undefined;
  next.updatedAt = new Date().toISOString();

  const [row, created] = await db.platformSetting.findOrCreate({
    where: { key: META_KEY },
    defaults: { key: META_KEY, value: next, updatedByUserId: userId || null },
  });
  if (!created) await row.update({ value: next, updatedByUserId: userId || null });
  return getMetaConfigMasked(db);
}

export default {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  isChannelEnabled,
  getWallet,
  debitWallet,
  creditWallet,
  creditWalletFromRecharge,
  estimateCost,
  getMetaConfig,
  isMetaConfigured,
  getMetaConfigMasked,
  saveMetaConfig,
};
