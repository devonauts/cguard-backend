/**
 * Unit tests — unified communications layer (routing + webhook + helpers).
 *
 * These tests exercise the REAL messageRouter / settings / wallet / log services
 * end-to-end against an in-memory fake `db` (no MySQL, no network). Only the
 * provider `.send()` calls are stubbed with sinon, so the actual routing rules,
 * channel cascade, wallet gating, debits and logging are all under test.
 *
 * Coverage:
 *   1.  Push-first routing (push wins, paid channels not attempted).
 *   2.  WhatsApp fallback when push has no token.
 *   3.  SMS fallback when WhatsApp unavailable (critical).
 *   4.  Critical = multi-channel fan-out (push + WhatsApp + SMS).
 *   5.  Wallet-insufficient BLOCKS a non-critical paid send (skipped + logged).
 *   6.  OTP — WhatsApp-preferred, SMS fallback when WhatsApp disabled.
 *   7.  Meta webhook GET verification (challenge) + 403 on bad token.
 *   8.  Meta webhook POST signature verification (HMAC).
 *   9.  Webhook status → updateStatusByProviderMessageId mapping.
 *   10. Twilio SMS provider still works (low-level, no double-debit).
 *   11. Tenant isolation on logs (queryLogs scoped to tenantId).
 *   12. Invalid / missing phone normalization.
 *   13. Missing-credentials graceful skip (provider not configured → skipped).
 *
 * Run:  npm run test:unit
 *   (or)  cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *           mocha -r ts-node/register \
 *           'src/services/communication/__tests__/routing.test.ts' --exit
 */

import assert from 'assert';
import crypto from 'crypto';
import sinon from 'sinon';
import httpMocks from 'node-mocks-http';

import { route } from '../messageRouter';
import { pushProvider } from '../providers/pushProvider';
import { metaWhatsAppProvider } from '../providers/metaWhatsAppProvider';
import { twilioSmsProvider } from '../providers/twilioSmsProvider';
import { emailProvider } from '../providers/emailProvider';
import * as logService from '../communicationLogService';
import { normalizeToE164, toWhatsAppRecipient } from '../phone';
import { metaWebhookVerify, metaWebhookReceive } from '../../../api/communication/metaWebhook';
import { CommunicationSettings, SendResult } from '../types';
import { DEFAULT_SETTINGS } from '../communicationSettingsService';

// ───────────────────────────── In-memory fake DB ─────────────────────────────
//
// A tiny Sequelize-shaped stub: just enough for the real services to run. Each
// "model" supports the handful of calls the comms services make. Rows live in
// plain arrays so we can assert on persisted communicationLogs.

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PHONE = '+593987654321';

function makeRow(data: any) {
  return {
    ...data,
    get(opts?: any) {
      if (opts && opts.plain) return { ...data };
      return data;
    },
    async update(patch: any) {
      Object.assign(data, patch);
      Object.assign(this, patch);
      return this;
    },
  };
}

interface FakeDb {
  communicationLogs: any[];
  settingsRows: Record<string, any>;
  wallets: Record<string, any>;
  rates: any[];
  devices: any[];
  users: Record<string, any>;
  [key: string]: any;
}

/**
 * Build a fresh fake db. `opts` seeds per-tenant settings, wallet balance,
 * provider rates, device tokens and users.
 */
function buildDb(opts: {
  settings?: Partial<CommunicationSettings>;
  settingsByTenant?: Record<string, Partial<CommunicationSettings>>;
  walletCents?: number;
  walletByTenant?: Record<string, number>;
  rates?: Array<{
    provider: string;
    channel: string;
    countryCode?: string | null;
    messageType?: string | null;
    costCents: number;
    markupPercentage?: number;
    active?: boolean;
  }>;
  devices?: Array<{ tenantId: string; userId: string; pushToken?: string | null }>;
  users?: Record<string, { phoneNumber?: string; email?: string }>;
} = {}): FakeDb {
  const db: FakeDb = {
    communicationLogs: [],
    settingsRows: {},
    wallets: {},
    rates: (opts.rates || []).map((r) =>
      makeRow({ currency: 'USD', markupPercentage: 0, active: true, countryCode: null, messageType: null, ...r }),
    ),
    devices: (opts.devices || []).map((d) => makeRow({ ...d })),
    users: opts.users || {},
  };

  // Seed settings rows.
  const seedSettings = (tid: string, s: Partial<CommunicationSettings>) => {
    db.settingsRows[tid] = makeRow({ id: tid, tenantId: tid, communicationSettings: { ...s } });
  };
  if (opts.settings) seedSettings(TENANT_A, opts.settings);
  if (opts.settingsByTenant) {
    for (const [tid, s] of Object.entries(opts.settingsByTenant)) seedSettings(tid, s);
  }

  // Seed wallets.
  const seedWallet = (tid: string, cents: number) => {
    db.wallets[tid] = makeRow({
      tenantId: tid,
      balanceCents: cents,
      currency: 'USD',
      lowBalanceThresholdCents: 500,
    });
  };
  if (opts.walletCents != null) seedWallet(TENANT_A, opts.walletCents);
  if (opts.walletByTenant) {
    for (const [tid, c] of Object.entries(opts.walletByTenant)) seedWallet(tid, c);
  }

  // ── Model: settings (PK = tenantId) ─────────────────────────────────────
  db.settings = {
    async findByPk(id: string) {
      return db.settingsRows[id] || null;
    },
    async findOrCreate({ where, defaults }: any) {
      const id = where.id;
      if (!db.settingsRows[id]) {
        db.settingsRows[id] = makeRow({ communicationSettings: {}, ...defaults });
        return [db.settingsRows[id], true];
      }
      return [db.settingsRows[id], false];
    },
  };

  // ── Model: communicationWallet ──────────────────────────────────────────
  db.communicationWallet = {
    async findOrCreate({ where, defaults }: any) {
      const tid = where.tenantId;
      if (!db.wallets[tid]) {
        db.wallets[tid] = makeRow({ ...defaults });
        return [db.wallets[tid], true];
      }
      return [db.wallets[tid], false];
    },
  };

  // ── Model: communicationProviderRate ────────────────────────────────────
  db.communicationProviderRate = {
    async findAll({ where }: any) {
      return db.rates.filter(
        (r: any) =>
          r.provider === where.provider &&
          r.channel === where.channel &&
          (where.active === undefined || r.active === where.active),
      );
    },
  };

  // ── Model: communicationLog ─────────────────────────────────────────────
  db.communicationLog = {
    async create(data: any) {
      const row = makeRow({ id: `log-${db.communicationLogs.length + 1}`, ...data });
      db.communicationLogs.push(row);
      return row;
    },
    async findOne({ where }: any) {
      return (
        db.communicationLogs.find((r: any) => {
          if (where.providerMessageId) return r.providerMessageId === where.providerMessageId;
          return false;
        }) || null
      );
    },
    async findAndCountAll({ where, limit, offset }: any) {
      let rows = db.communicationLogs.filter((r: any) => {
        if (where.tenantId && r.tenantId !== where.tenantId) return false;
        if (where.channel && r.channel !== where.channel) return false;
        if (where.status && r.status !== where.status) return false;
        if (where.provider && r.provider !== where.provider) return false;
        if (where.messageType && r.messageType !== where.messageType) return false;
        return true;
      });
      const count = rows.length;
      rows = rows.slice(offset || 0, (offset || 0) + (limit || 50));
      return { rows, count };
    },
  };

  // ── Model: deviceIdInformation ──────────────────────────────────────────
  db.deviceIdInformation = {
    async findAll({ where }: any) {
      return db.devices.filter(
        (d: any) => d.tenantId === where.tenantId && d.userId === where.userId,
      );
    },
  };

  // ── Model: user ─────────────────────────────────────────────────────────
  db.user = {
    async findByPk(id: string) {
      const u = db.users[id];
      return u ? makeRow({ id, ...u }) : null;
    },
  };

  // ── sequelize.transaction (debit/credit wallet uses a tx with row lock) ──
  db.sequelize = {
    async transaction() {
      return {
        LOCK: { UPDATE: 'UPDATE' },
        async commit() {
          /* no-op */
        },
        async rollback() {
          /* no-op */
        },
      };
    },
  };

  return db;
}

/** A stubbed provider.send result. */
function ok(channel: string, provider: string, extra: Partial<SendResult> = {}): SendResult {
  return { status: 'sent', channel: channel as any, provider, providerMessageId: `pmid-${channel}`, ...extra };
}
function skip(channel: string, provider: string, reason: string): SendResult {
  return { status: 'skipped', channel: channel as any, provider, skipReason: reason };
}

const ENABLE_ALL: Partial<CommunicationSettings> = {
  push_enabled: true,
  whatsapp_enabled: true,
  sms_enabled: true,
  email_enabled: true,
  wallet_required_for_paid_channels: true,
};

// ─────────────────────────────────── Tests ───────────────────────────────────

describe('Communications — MessageRouter routing rules', () => {
  let pushSend: sinon.SinonStub;
  let waSend: sinon.SinonStub;
  let smsSend: sinon.SinonStub;
  let emailSend: sinon.SinonStub;
  let waConfigured: sinon.SinonStub;
  let smsConfigured: sinon.SinonStub;
  let emailConfigured: sinon.SinonStub;

  beforeEach(() => {
    // Stub provider transports so no real Firebase / Meta / Twilio is hit.
    pushSend = sinon.stub(pushProvider, 'send');
    waSend = sinon.stub(metaWhatsAppProvider, 'send');
    smsSend = sinon.stub(twilioSmsProvider, 'send');
    emailSend = sinon.stub(emailProvider, 'send');

    // By default every paid/optional provider reports itself configured so the
    // wallet/routing logic (not credential gating) is what's under test. Tests
    // that probe credential gating override these.
    waConfigured = sinon.stub(metaWhatsAppProvider, 'isConfigured').resolves(true);
    smsConfigured = sinon.stub(twilioSmsProvider, 'isConfigured').resolves(true);
    emailConfigured = sinon.stub(emailProvider, 'isConfigured').resolves(true);

    pushSend.resolves(ok('push', 'firebase'));
    waSend.resolves(ok('whatsapp', 'meta', { costEstimateCents: 1 }));
    smsSend.resolves(ok('sms', 'twilio', { costEstimateCents: 5 }));
    emailSend.resolves(ok('email', 'smtp'));
  });

  afterEach(() => sinon.restore());

  // 1 ── Push-first: push succeeds → paid channels NOT attempted ───────────
  it('routes push-first and stops at push for non-critical operational alerts', async () => {
    const db = buildDb({
      settings: ENABLE_ALL,
      walletCents: 10000,
      devices: [{ tenantId: TENANT_A, userId: 'u1', pushToken: 'tok-1' }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      userId: 'u1',
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
      phone: PHONE,
    });

    assert.strictEqual(results.length, 1, 'should stop after push success');
    assert.strictEqual(results[0].channel, 'push');
    assert.strictEqual(results[0].status, 'sent');
    assert.ok(pushSend.calledOnce);
    assert.ok(waSend.notCalled, 'WhatsApp must not be charged when push wins');
    assert.ok(smsSend.notCalled);

    // Exactly one log row, for the push attempt.
    assert.strictEqual(db.communicationLogs.length, 1);
    assert.strictEqual(db.communicationLogs[0].channel, 'push');
  });

  // 2 ── WhatsApp fallback when push has no token ──────────────────────────
  it('falls back to WhatsApp when the user has no push token', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    const db = buildDb({
      settings: ENABLE_ALL,
      walletCents: 10000,
      devices: [], // no tokens
      rates: [{ provider: 'meta', channel: 'whatsapp', costCents: 1 }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      userId: 'u1',
      phone: PHONE,
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
    });

    assert.ok(pushSend.calledOnce);
    assert.ok(waSend.calledOnce, 'WhatsApp should be attempted after push skip');
    const waResult = results.find((r) => r.channel === 'whatsapp');
    assert.ok(waResult && waResult.status === 'sent');
    // Stopped at WhatsApp success (non-critical) → SMS not attempted.
    assert.ok(smsSend.notCalled);
  });

  // 3 ── SMS fallback when WhatsApp unavailable on a critical alert ─────────
  it('falls back to SMS when push + WhatsApp fail on a critical alert', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    waSend.resolves(skip('whatsapp', 'meta', 'outside_24h_window_no_template'));
    const db = buildDb({
      settings: { ...ENABLE_ALL, critical_alert_sms_fallback: true, sms_critical: true },
      walletCents: 10000,
      rates: [{ provider: 'twilio', channel: 'sms', costCents: 5 }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'incident_alert',
      critical: true,
      title: 'Incidente',
      body: 'Robo en sitio',
    });

    const channels = results.map((r) => r.channel);
    assert.deepStrictEqual(channels, ['push', 'whatsapp', 'sms']);
    assert.ok(smsSend.calledOnce, 'SMS must be the critical fallback');
    const smsResult = results.find((r) => r.channel === 'sms');
    assert.strictEqual(smsResult!.status, 'sent');
  });

  // 4 ── Critical fan-out: push + WhatsApp + SMS all fire ──────────────────
  it('fans out a panic alert to push + WhatsApp + SMS (no early stop)', async () => {
    const db = buildDb({
      settings: ENABLE_ALL,
      walletCents: 10000,
      devices: [{ tenantId: TENANT_A, userId: 'u1', pushToken: 'tok-1' }],
      rates: [
        { provider: 'meta', channel: 'whatsapp', costCents: 1 },
        { provider: 'twilio', channel: 'sms', costCents: 5 },
      ],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      userId: 'u1',
      phone: PHONE,
      messageType: 'panic',
      critical: true,
      title: 'PÁNICO',
      body: 'Botón de pánico activado',
    });

    const channels = results.map((r) => r.channel).sort();
    assert.deepStrictEqual(channels, ['push', 'sms', 'whatsapp']);
    assert.ok(pushSend.calledOnce && waSend.calledOnce && smsSend.calledOnce);
    // All three channels logged.
    assert.strictEqual(db.communicationLogs.length, 3);
  });

  // 5 ── Wallet-insufficient blocks a NON-critical paid send ───────────────
  it('skips + logs a paid WhatsApp send when the wallet is insufficient (non-critical)', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    const db = buildDb({
      settings: { ...ENABLE_ALL, wallet_required_for_paid_channels: true },
      walletCents: 0, // empty wallet
      rates: [
        { provider: 'meta', channel: 'whatsapp', costCents: 1 },
        { provider: 'twilio', channel: 'sms', costCents: 5 },
      ],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
    });

    const waResult = results.find((r) => r.channel === 'whatsapp');
    assert.ok(waResult, 'WhatsApp attempt should be recorded');
    assert.strictEqual(waResult!.status, 'skipped');
    assert.strictEqual(waResult!.skipReason, 'insufficient_balance');
    assert.ok(waSend.notCalled, 'provider.send must NOT run when wallet blocks it');

    // The skip is logged with the reason.
    const waLog = db.communicationLogs.find((l: any) => l.channel === 'whatsapp');
    assert.ok(waLog);
    assert.strictEqual(waLog.status, 'skipped');
    assert.strictEqual(waLog.errorMessage, 'insufficient_balance');
  });

  // 5b ── Critical + allow_negative overrides the wallet block ─────────────
  it('allows a critical paid send to go negative when allow_negative is set', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    waSend.resolves(skip('whatsapp', 'meta', 'outside_24h_window_no_template'));
    const db = buildDb({
      settings: {
        ...ENABLE_ALL,
        wallet_required_for_paid_channels: true,
        allow_negative_communications_balance: true,
        critical_alert_sms_fallback: true,
        sms_critical: true,
      },
      walletCents: 0,
      rates: [{ provider: 'twilio', channel: 'sms', costCents: 5 }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'incident_alert',
      critical: true,
      title: 'Incidente',
      body: 'Crítico',
    });

    const smsResult = results.find((r) => r.channel === 'sms');
    assert.ok(smsResult);
    assert.notStrictEqual(smsResult!.skipReason, 'insufficient_balance');
    assert.ok(smsSend.calledOnce, 'critical send must proceed despite empty wallet');
    // Wallet went negative by the SMS cost.
    assert.strictEqual(db.wallets[TENANT_A].balanceCents, -5);
  });

  // 6 ── OTP: WhatsApp-preferred, SMS fallback when WhatsApp disabled ───────
  it('routes OTP to WhatsApp when preferred + enabled', async () => {
    const db = buildDb({
      settings: { ...ENABLE_ALL, otp_preferred_channel: 'whatsapp' },
      walletCents: 10000,
      rates: [{ provider: 'meta', channel: 'whatsapp', costCents: 1 }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'otp',
      critical: true,
      templateName: 'otp_code',
      templateVars: { '1': '123456' },
      body: 'Tu código es 123456',
    });

    // OTP stops at first success → only WhatsApp.
    assert.strictEqual(results[0].channel, 'whatsapp');
    assert.strictEqual(results[0].status, 'sent');
    assert.ok(waSend.calledOnce);
    assert.ok(smsSend.notCalled);
    // Push must NEVER be used for OTP.
    assert.ok(pushSend.notCalled);
  });

  it('routes OTP to SMS when WhatsApp is disabled / preferred=sms', async () => {
    const db = buildDb({
      settings: { ...ENABLE_ALL, whatsapp_enabled: false, otp_preferred_channel: 'sms' },
      walletCents: 10000,
      rates: [{ provider: 'twilio', channel: 'sms', costCents: 5 }],
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'otp',
      critical: true,
      body: 'Tu código es 123456',
    });

    const smsResult = results.find((r) => r.channel === 'sms');
    assert.ok(smsResult && smsResult.status === 'sent', 'SMS must deliver the OTP');
    assert.ok(smsSend.calledOnce);
    assert.ok(pushSend.notCalled, 'OTP never uses push');
  });

  // 12 ── Missing-credentials graceful skip ────────────────────────────────
  it('skips WhatsApp gracefully when the Meta provider is not configured', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    waConfigured.resolves(false); // credentials missing
    const db = buildDb({ settings: ENABLE_ALL, walletCents: 10000 });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
    });

    const waResult = results.find((r) => r.channel === 'whatsapp');
    assert.ok(waResult);
    assert.strictEqual(waResult!.status, 'skipped');
    assert.strictEqual(waResult!.skipReason, 'not_configured');
    assert.ok(waSend.notCalled, 'send must not run for an unconfigured provider');
  });

  it('skips a channel that is disabled in tenant settings', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    const db = buildDb({
      settings: { push_enabled: true, whatsapp_enabled: false, sms_enabled: false },
      walletCents: 10000,
    });

    const results = await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
    });

    const waResult = results.find((r) => r.channel === 'whatsapp');
    assert.ok(waResult && waResult.status === 'skipped');
    assert.strictEqual(waResult!.skipReason, 'channel_disabled');
    assert.ok(waSend.notCalled);
  });

  // Wallet debit on a successful paid send.
  it('debits the wallet exactly once after a successful WhatsApp send', async () => {
    pushSend.resolves(skip('push', 'firebase', 'no_token'));
    waSend.resolves(ok('whatsapp', 'meta', { costEstimateCents: 1 }));
    const db = buildDb({
      settings: ENABLE_ALL,
      walletCents: 100,
      rates: [{ provider: 'meta', channel: 'whatsapp', costCents: 1, markupPercentage: 0 }],
    });

    await route(db, {
      tenantId: TENANT_A,
      phone: PHONE,
      messageType: 'generic',
      title: 'Hi',
      body: 'Body',
    });

    assert.strictEqual(db.wallets[TENANT_A].balanceCents, 99, 'wallet should drop by 1 cent');
  });
});

// ───────────────────── Tenant isolation on the log feed ──────────────────────

describe('Communications — log tenant isolation', () => {
  afterEach(() => sinon.restore());

  it('queryLogs only returns rows for the requested tenant', async () => {
    const db = buildDb();
    await logService.log(db, {
      tenantId: TENANT_A,
      channel: 'push',
      messageType: 'generic',
      status: 'sent',
      recipient: 'u1',
    });
    await logService.log(db, {
      tenantId: TENANT_B,
      channel: 'sms',
      messageType: 'otp',
      status: 'sent',
      recipient: PHONE,
    });

    const aFeed = await logService.queryLogs(db, TENANT_A);
    assert.strictEqual(aFeed.count, 1);
    assert.strictEqual(aFeed.rows[0].tenantId, TENANT_A);

    const bFeed = await logService.queryLogs(db, TENANT_B);
    assert.strictEqual(bFeed.count, 1);
    assert.strictEqual(bFeed.rows[0].tenantId, TENANT_B);
    assert.strictEqual(bFeed.rows[0].channel, 'sms');
  });

  it('filters the log feed by channel within a tenant', async () => {
    const db = buildDb();
    await logService.log(db, { tenantId: TENANT_A, channel: 'push', messageType: 'generic', status: 'sent' });
    await logService.log(db, { tenantId: TENANT_A, channel: 'whatsapp', messageType: 'generic', status: 'sent' });

    const feed = await logService.queryLogs(db, TENANT_A, { channel: 'whatsapp' });
    assert.strictEqual(feed.count, 1);
    assert.strictEqual(feed.rows[0].channel, 'whatsapp');
  });
});

// ─────────────────── Webhook status → log status mapping ──────────────────────

describe('Communications — webhook status update mapping', () => {
  afterEach(() => sinon.restore());

  it('advances a log row by providerMessageId and stamps the timestamp', async () => {
    const db = buildDb();
    const id = await logService.log(db, {
      tenantId: TENANT_A,
      channel: 'whatsapp',
      provider: 'meta',
      messageType: 'incident_alert',
      status: 'sent',
      providerMessageId: 'wamid.ABC123',
      recipient: PHONE,
    });
    assert.ok(id);

    const at = new Date('2026-06-15T12:00:00Z');
    const updated = await logService.updateStatusByProviderMessageId(db, 'wamid.ABC123', 'delivered', at);
    assert.strictEqual(updated, true);

    const row = db.communicationLogs.find((r: any) => r.providerMessageId === 'wamid.ABC123');
    assert.strictEqual(row.status, 'delivered');
    assert.strictEqual(row.deliveredAt.getTime(), at.getTime());

    // 'read' also back-fills deliveredAt.
    await logService.updateStatusByProviderMessageId(db, 'wamid.ABC123', 'read', at);
    assert.strictEqual(row.status, 'read');
    assert.ok(row.readAt);
  });

  it('returns false when no row matches the providerMessageId', async () => {
    const db = buildDb();
    const updated = await logService.updateStatusByProviderMessageId(db, 'wamid.NOPE', 'delivered');
    assert.strictEqual(updated, false);
  });
});

// ──────────────────────── Meta webhook GET + POST ─────────────────────────────

describe('Communications — Meta WhatsApp webhook', () => {
  const VERIFY_TOKEN = 'verify-secret-token';
  const APP_SECRET = 'app-secret-xyz';

  beforeEach(() => {
    process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.META_APP_SECRET = APP_SECRET;
    // Ensure no DB-stored Meta config shadows env (force env fallback).
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
  });

  afterEach(() => {
    delete process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    delete process.env.META_APP_SECRET;
    sinon.restore();
  });

  /** A db whose platformSetting has no Meta row → getMetaConfig falls back to env. */
  function webhookDb() {
    const db: any = buildDb();
    db.platformSetting = { async findOne() { return null; } };
    return db;
  }

  // 7 ── GET verification echoes the challenge on a matching token ──────────
  it('GET returns hub.challenge when verify token matches', async () => {
    const db = webhookDb();
    const req = httpMocks.createRequest({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '31415926' },
    });
    (req as any).database = db;
    const res = httpMocks.createResponse();

    await metaWebhookVerify(req as any, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res._getData(), '31415926');
  });

  it('GET returns 403 on a wrong verify token', async () => {
    const db = webhookDb();
    const req = httpMocks.createRequest({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'WRONG', 'hub.challenge': '31415926' },
    });
    (req as any).database = db;
    const res = httpMocks.createResponse();

    await metaWebhookVerify(req as any, res);
    assert.strictEqual(res.statusCode, 403);
  });

  // 8 ── POST signature verification (HMAC-SHA256 over the raw body) ─────────
  it('POST rejects an invalid X-Hub-Signature-256 with 403', async () => {
    const db = webhookDb();
    const payload = JSON.stringify({ entry: [] });
    const req = httpMocks.createRequest({
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: { entry: [] },
    });
    (req as any).database = db;
    (req as any).rawBody = payload;
    const res = httpMocks.createResponse();

    await metaWebhookReceive(req as any, res);
    assert.strictEqual(res.statusCode, 403, 'bad signature must be rejected');
  });

  // 9 ── POST with a valid signature updates the log status ─────────────────
  it('POST with a valid signature maps a status callback to the log row', async () => {
    const db = webhookDb();
    // Seed a sent WhatsApp log to be advanced by the webhook.
    await logService.log(db, {
      tenantId: TENANT_A,
      channel: 'whatsapp',
      provider: 'meta',
      messageType: 'incident_alert',
      status: 'sent',
      providerMessageId: 'wamid.HELLO',
      recipient: PHONE,
    });

    const bodyObj = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.HELLO', status: 'delivered', timestamp: '1718452800' },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(bodyObj);
    const signature =
      'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex');

    const req = httpMocks.createRequest({
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body: bodyObj,
    });
    (req as any).database = db;
    (req as any).rawBody = raw;
    const res = httpMocks.createResponse();

    await metaWebhookReceive(req as any, res);

    assert.strictEqual(res.statusCode, 200);
    const row = db.communicationLogs.find((r: any) => r.providerMessageId === 'wamid.HELLO');
    assert.strictEqual(row.status, 'delivered', 'status callback should mark the log delivered');
  });
});

// ─────────────────── Twilio SMS provider (still works) ────────────────────────

describe('Communications — Twilio SMS provider (non-breaking)', () => {
  afterEach(() => sinon.restore());

  it('sends via the tenant Twilio subaccount WITHOUT touching the legacy wallet', async () => {
    // Stub the legacy smsAccountService that the provider require()s. The provider
    // does a low-level client.messages.create — NO sendSmsForTenant, NO
    // tenantSmsAccount debit — so the unified router can own billing.
    const created: any[] = [];
    const fakeClient = {
      messages: {
        async create(payload: any) {
          created.push(payload);
          return { sid: 'SM123', status: 'queued' };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const smsAccountService = require('../../smsAccountService');
    sinon.stub(smsAccountService, 'getAccount').resolves({ provisioned: true, hasSender: true });
    sinon.stub(smsAccountService, 'ensureLocalAccount').resolves({ phoneNumber: '+15005550006' });
    sinon.stub(smsAccountService, 'subaccountClient').returns(fakeClient);

    const result = await twilioSmsProvider.send({} as any, {
      tenantId: TENANT_A,
      recipient: PHONE,
      channel: 'sms',
      messageType: 'generic',
      body: 'Hola',
    });

    assert.strictEqual(result.status, 'sent');
    assert.strictEqual(result.provider, 'twilio');
    assert.strictEqual(result.providerMessageId, 'SM123');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].to, PHONE);
    assert.strictEqual(created[0].from, '+15005550006');
  });

  it('skips (does not fail) when the tenant has no provisioned subaccount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const smsAccountService = require('../../smsAccountService');
    sinon.stub(smsAccountService, 'getAccount').resolves({ provisioned: false, hasSender: false });
    sinon.stub(smsAccountService, 'ensureLocalAccount').resolves({});
    sinon.stub(smsAccountService, 'subaccountClient').returns(null);

    const result = await twilioSmsProvider.send({} as any, {
      tenantId: TENANT_A,
      recipient: PHONE,
      channel: 'sms',
      messageType: 'generic',
      body: 'Hola',
    });

    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.skipReason, 'no_subaccount');
  });

  it('skips an invalid recipient instead of calling Twilio', async () => {
    const result = await twilioSmsProvider.send({} as any, {
      tenantId: TENANT_A,
      recipient: '123', // too short
      channel: 'sms',
      messageType: 'generic',
      body: 'Hola',
    });
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.skipReason, 'no_recipient');
  });
});

// ─────────────────────────── Phone normalization ─────────────────────────────

describe('Communications — phone normalization', () => {
  it('normalizes a local number with the tenant default country code', () => {
    // Ecuador local with national 0 → +593 …
    assert.strictEqual(normalizeToE164('0987654321', '+593'), '+593987654321');
  });

  it('keeps an already-international number untouched', () => {
    assert.strictEqual(normalizeToE164('+593987654321', '+593'), '+593987654321');
    assert.strictEqual(normalizeToE164('+1 (305) 555-0123', '+593'), '+13055550123');
  });

  it('treats a 00-prefixed number as international', () => {
    assert.strictEqual(normalizeToE164('00593987654321', '+593'), '+593987654321');
  });

  it('does not double-apply the country code', () => {
    assert.strictEqual(normalizeToE164('593987654321', '+593'), '+593987654321');
  });

  it('returns null for missing or too-short input', () => {
    assert.strictEqual(normalizeToE164('', '+593'), null);
    assert.strictEqual(normalizeToE164(null, '+593'), null);
    assert.strictEqual(normalizeToE164('123', '+593'), null);
  });

  it('produces a Graph-API recipient (digits only, no +)', () => {
    assert.strictEqual(toWhatsAppRecipient('0987654321', '+593'), '593987654321');
    assert.strictEqual(toWhatsAppRecipient('bad', '+593'), null);
  });
});

// ─────────────────────────── Defaults sanity check ───────────────────────────

describe('Communications — settings defaults', () => {
  it('exposes the documented defaults', () => {
    assert.strictEqual(DEFAULT_SETTINGS.push_enabled, true);
    assert.strictEqual(DEFAULT_SETTINGS.whatsapp_enabled, false);
    // SMS defaults ON — the funded-wallet requirement is the real gate
    // (wallet_required_for_paid_channels below).
    assert.strictEqual(DEFAULT_SETTINGS.sms_enabled, true);
    assert.strictEqual(DEFAULT_SETTINGS.email_enabled, true);
    assert.strictEqual(DEFAULT_SETTINGS.otp_preferred_channel, 'whatsapp');
    assert.strictEqual(DEFAULT_SETTINGS.default_country_code, '+593');
    assert.strictEqual(DEFAULT_SETTINGS.wallet_required_for_paid_channels, true);
  });
});
