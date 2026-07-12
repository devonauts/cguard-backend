/**
 * Per-tenant SMS account: Twilio subaccount provisioning + number management.
 *
 * - Each tenant gets its own Twilio subaccount (created under the platform
 *   master account: TWILIO_MASTER_ACCOUNT_SID / TWILIO_MASTER_AUTH_TOKEN).
 * - The LEGACY prepaid wallet on tenantSmsAccounts is RETIRED: balances were
 *   migrated into communicationWallets (z20260713b) and message billing now
 *   debits that unified wallet (smsService / messageRouter). The local `debit`
 *   here remains only for the one-time number-purchase fee; smsTransactions
 *   stays as the SMS history ledger.
 *
 * Everything degrades gracefully: with no master credentials, provisioning is a
 * clear no-op; sending is skipped until Twilio is configured and a sender
 * number is attached.
 */
import { encryptPrivateUrl, decryptPrivateUrl } from '../utils/privateUrlEncryption';

/** Price charged to the tenant wallet per SMS segment, in cents. */
export function smsPriceCents(): number {
  const raw = parseInt(process.env.SMS_PRICE_CENTS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Optional one-time setup fee charged to the wallet when buying a number. */
export function numberPriceCents(): number {
  const raw = parseInt(process.env.SMS_NUMBER_PRICE_CENTS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** True when the platform has Twilio master credentials configured. */
export function isTwilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_MASTER_ACCOUNT_SID && process.env.TWILIO_MASTER_AUTH_TOKEN);
}

function masterClient(): any {
  if (!isTwilioConfigured()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    return twilio(process.env.TWILIO_MASTER_ACCOUNT_SID, process.env.TWILIO_MASTER_AUTH_TOKEN);
  } catch (e: any) {
    console.warn('[smsAccount] twilio SDK unavailable:', e?.message || e);
    return null;
  }
}

export function subaccountClient(account: any): any {
  if (!account?.subaccountSid || !account?.authTokenEnc) return null;
  try {
    const token = decryptPrivateUrl(account.authTokenEnc);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    return twilio(account.subaccountSid, token);
  } catch (e: any) {
    console.warn('[smsAccount] could not build subaccount client:', e?.message || e);
    return null;
  }
}

/** Get-or-create the local SMS account row for a tenant. */
export async function ensureLocalAccount(db: any, tenantId: string): Promise<any> {
  const [row] = await db.tenantSmsAccount.findOrCreate({
    where: { tenantId },
    defaults: { tenantId, balanceCents: 0, currency: 'USD', status: 'inactive' },
  });
  return row;
}

/** Public account snapshot (no secrets). */
export async function getAccount(db: any, tenantId: string) {
  const row = await ensureLocalAccount(db, tenantId);
  const p = row.get({ plain: true });
  return {
    balanceCents: p.balanceCents || 0,
    currency: p.currency || 'USD',
    status: p.status || 'inactive',
    subaccountSid: p.subaccountSid || null,
    phoneNumber: p.phoneNumber || null,
    hasSender: !!(p.phoneNumber || p.messagingServiceSid),
    provisioned: !!p.subaccountSid,
    platformConfigured: isTwilioConfigured(),
    pricePerSmsCents: smsPriceCents(),
  };
}

/**
 * Create the tenant's Twilio subaccount if it doesn't exist yet. Stores the
 * subaccount SID + the (encrypted) auth token. Idempotent.
 */
export async function provisionSubaccount(db: any, tenant: any): Promise<any> {
  const tenantId = tenant.id;
  const row = await ensureLocalAccount(db, tenantId);
  if (row.subaccountSid) {
    return getAccount(db, tenantId);
  }

  const client = masterClient();
  if (!client) {
    const err: any = new Error('Twilio no está configurado en la plataforma.');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }

  const friendlyName = `CGuardPro · ${tenant.name || 'Tenant'} · ${tenantId}`.slice(0, 64);
  const sub = await client.api.v2010.accounts.create({ friendlyName });

  await row.update({
    subaccountSid: sub.sid,
    authTokenEnc: encryptPrivateUrl(sub.authToken),
    status: 'active',
  });

  return getAccount(db, tenantId);
}

// NOTE: the legacy `credit()` recharge function was REMOVED — the prepaid
// tenantSmsAccount wallet is retired (balances migrated to communicationWallets
// by z20260713b) and all recharges land in the unified wallet via
// communicationSettingsService.creditWalletFromRecharge. `debit()` below stays
// only for the one-time number-purchase fee in buyNumber().

/**
 * Debit the wallet for a sent message. Returns ok=false (without spending) when
 * the balance is insufficient.
 */
export async function debit(
  db: any,
  tenantId: string,
  amountCents: number,
  opts: { reference?: string; description?: string; smsCount?: number } = {},
): Promise<{ ok: boolean; balanceAfterCents: number }> {
  if (!(amountCents > 0)) return { ok: true, balanceAfterCents: 0 };

  const t = await db.sequelize.transaction();
  try {
    const row = await db.tenantSmsAccount.findOne({
      where: { tenantId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const balance = row ? row.balanceCents || 0 : 0;
    if (!row || balance < amountCents) {
      await t.commit();
      return { ok: false, balanceAfterCents: balance };
    }

    const balanceAfter = balance - amountCents;
    await row.update({ balanceCents: balanceAfter }, { transaction: t });

    await db.smsTransaction.create(
      {
        tenantId,
        type: 'debit',
        amountCents: -amountCents,
        balanceAfterCents: balanceAfter,
        smsCount: opts.smsCount || 1,
        currency: row.currency || 'USD',
        reference: opts.reference || null,
        description: opts.description || 'Envío de SMS',
      },
      { transaction: t },
    );

    await t.commit();
    return { ok: true, balanceAfterCents: balanceAfter };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Search Twilio for SMS-capable numbers available to purchase into the tenant's
 * subaccount. Returns a lightweight list for the UI to choose from.
 */
export async function listAvailableNumbers(
  db: any,
  tenant: any,
  opts: { country?: string; areaCode?: string | number; contains?: string; limit?: number } = {},
): Promise<any[]> {
  const row = await ensureLocalAccount(db, tenant.id);
  const client = subaccountClient(row) || masterClient();
  if (!client) {
    const err: any = new Error('Twilio no está configurado en la plataforma.');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }

  const country = (opts.country || 'US').toUpperCase();
  const query: any = { smsEnabled: true, limit: Math.min(Number(opts.limit) || 10, 20) };
  if (opts.areaCode) query.areaCode = Number(opts.areaCode);
  if (opts.contains) query.contains = String(opts.contains);

  const list = await client.availablePhoneNumbers(country).local.list(query);
  return (list || []).map((n: any) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
    isoCountry: n.isoCountry,
  }));
}

/**
 * Purchase a number into the tenant's subaccount and set it as the sender.
 * Optionally charges a one-time setup fee (SMS_NUMBER_PRICE_CENTS) to the wallet.
 */
export async function buyNumber(
  db: any,
  tenant: any,
  args: { phoneNumber?: string; country?: string; areaCode?: string | number } = {},
): Promise<any> {
  const tenantId = tenant.id;
  const row = await ensureLocalAccount(db, tenantId);

  if (!row.subaccountSid) {
    const err: any = new Error('Primero crea la subcuenta SMS.');
    err.code = 'NO_SUBACCOUNT';
    throw err;
  }
  const client = subaccountClient(row);
  if (!client) {
    const err: any = new Error('Twilio no está configurado en la plataforma.');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }

  // Resolve a concrete number to buy.
  let phoneNumber = args.phoneNumber;
  if (!phoneNumber) {
    const found = await listAvailableNumbers(db, tenant, {
      country: args.country,
      areaCode: args.areaCode,
      limit: 1,
    });
    if (!found.length) {
      const err: any = new Error('No hay números disponibles con esos criterios.');
      err.code = 'NO_NUMBERS';
      throw err;
    }
    phoneNumber = found[0].phoneNumber;
  }

  // Optional one-time fee — require balance before purchasing.
  const fee = numberPriceCents();
  if (fee > 0) {
    const snap = await getAccount(db, tenantId);
    if (snap.balanceCents < fee) {
      const err: any = new Error('Saldo insuficiente para adquirir un número.');
      err.code = 'INSUFFICIENT_BALANCE';
      throw err;
    }
  }

  const purchased = await client.incomingPhoneNumbers.create({ phoneNumber });

  await row.update({ phoneNumber: purchased.phoneNumber, status: 'active' });

  if (fee > 0) {
    await debit(db, tenantId, fee, {
      reference: purchased.sid,
      description: `Compra de número ${purchased.phoneNumber}`,
      smsCount: 0,
    });
  }

  return getAccount(db, tenantId);
}

export async function listTransactions(db: any, tenantId: string, limit = 50) {
  const rows = await db.smsTransaction.findAll({
    where: { tenantId },
    order: [['createdAt', 'DESC']],
    limit,
  });
  return rows.map((r: any) => r.get({ plain: true }));
}
