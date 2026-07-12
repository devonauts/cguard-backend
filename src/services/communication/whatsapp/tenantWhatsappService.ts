/**
 * tenantWhatsappService — per-tenant WhatsApp Business via Meta Embedded Signup.
 *
 * Every tenant connects THEIR OWN WhatsApp Business account (official Meta
 * WhatsApp Business Platform: Cloud API + Embedded Signup through Facebook
 * Login for Business). The platform never owns numbers or pays Meta fees.
 *
 * Flow (frontend runs the Meta JS-SDK Embedded Signup popup):
 *   1. popup finishes → frontend receives { code, wabaId, phoneNumberId }
 *   2. POST .../whatsapp/callback → completeSignup():
 *        code → business integration token (server-side exchange, no
 *        redirect_uri for JS-SDK codes) → validate WABA access → subscribe our
 *        app to the WABA webhooks → fetch phone details → upsert
 *        tenantWhatsappAccounts (token secretBox-ENCRYPTED) → sync templates.
 *
 * Platform prerequisites (env): META_APP_ID, META_APP_SECRET,
 * META_ES_CONFIG_ID (the Facebook-Login-for-Business configuration id),
 * META_WHATSAPP_API_VERSION (optional, default v21.0).
 *
 * Tokens NEVER leave the backend: getStatus() only ever exposes tokenLast4.
 */
import { encrypt, decrypt, last4 } from '../../../lib/secretBox';
import { logSecurityEvent } from '../../auth/securityAudit';

const GRAPH_BASE = 'https://graph.facebook.com';
const FETCH_TIMEOUT_MS = 15000;
const MAX_TEMPLATE_PAGES = 5;

/** 400-style error carrying the real (Spanish) message through ApiResponseHandler. */
function err400(message: string): Error {
  return Object.assign(new Error(message), { code: 400 });
}

// ---------------------------------------------------------------------------
// Graph API fetch helper (timeout + retry)
// ---------------------------------------------------------------------------

interface GraphCallOpts {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  body?: any;
}

/**
 * Call the Graph API with a 15s timeout and up to 2 retries with backoff on
 * network errors / 5xx. NEVER retries a 4xx (those are deterministic — bad
 * code, revoked token, wrong id). Returns the parsed JSON; throws with the
 * Meta error message on a non-ok response.
 */
async function graphFetch(url: string, opts: GraphCallOpts = {}): Promise<any> {
  const maxAttempts = 3; // 1 try + 2 retries
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const json: any = await resp.json().catch(() => ({}));

      if (resp.ok) return json;

      // Meta error envelope: { error: { message, type, code, error_subcode } }
      const metaErr = json?.error || {};
      const msg = metaErr.message || `meta_http_${resp.status}`;
      if (resp.status >= 500 && attempt < maxAttempts) {
        lastError = new Error(msg);
      } else {
        // 4xx (or exhausted 5xx): deterministic — surface immediately.
        throw Object.assign(new Error(msg), {
          code: resp.status >= 500 ? 502 : 400,
          metaCode: metaErr.code,
          metaSubcode: metaErr.error_subcode,
        });
      }
    } catch (e: any) {
      if (e?.code) throw e; // our own deterministic error from above
      lastError = e; // network error / abort → retry
    } finally {
      clearTimeout(timer);
    }
    // Backoff before the next attempt (500ms, 1000ms).
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  throw Object.assign(
    new Error(lastError?.message || 'No se pudo contactar a Meta (Graph API).'),
    { code: 502 },
  );
}

// ---------------------------------------------------------------------------
// Embedded Signup params (platform-level env config)
// ---------------------------------------------------------------------------

export interface EmbeddedSignupParams {
  appId: string;
  configId: string;
  graphVersion: string;
  configured: boolean;
}

/**
 * Public (non-secret) params the frontend needs to launch the Meta JS-SDK
 * Embedded Signup popup. configured=false → the UI shows a "platform not
 * configured" hint instead of the connect button.
 */
export function getEmbeddedSignupParams(): EmbeddedSignupParams {
  const appId = process.env.META_APP_ID || '';
  const configId = process.env.META_ES_CONFIG_ID || '';
  const graphVersion = process.env.META_WHATSAPP_API_VERSION || 'v21.0';
  // appSecret is required server-side for the code exchange — without it the
  // callback would always fail, so the platform counts as not configured.
  const configured = !!(appId && configId && process.env.META_APP_SECRET);
  return { appId, configId, graphVersion, configured };
}

// ---------------------------------------------------------------------------
// Account row access (tenant-scoped)
// ---------------------------------------------------------------------------

async function findAccount(db: any, tenantId: string): Promise<any | null> {
  if (!db?.tenantWhatsappAccount || !tenantId) return null;
  return db.tenantWhatsappAccount.findOne({ where: { tenantId } });
}

// ---------------------------------------------------------------------------
// Status snapshot (masked — the token NEVER leaves the backend)
// ---------------------------------------------------------------------------

/**
 * Best-effort: did the tenant's last failed WhatsApp send look like an
 * UNREGISTERED Cloud API number? (Meta error 133010 / "register".) Drives the
 * `needsRegistration` hint in the status snapshot — deliberately stateless and
 * cheap; the CRM only shows a "register your number (PIN)" call-to-action.
 */
async function detectNeedsRegistration(db: any, tenantId: string): Promise<boolean> {
  try {
    if (!db?.communicationLog) return false;
    const row = await db.communicationLog.findOne({
      where: { tenantId, channel: 'whatsapp', status: 'failed' },
      order: [['createdAt', 'DESC']],
    });
    if (!row) return false;
    const msg = String(row.errorMessage || (row.get && row.get('errorMessage')) || '').toLowerCase();
    return msg.includes('133010') || (msg.includes('register') && msg.includes('phone'));
  } catch {
    return false;
  }
}

/** Masked per-tenant snapshot for the CRM. Includes the Embedded Signup params. */
export async function getStatus(db: any, tenantId: string) {
  const row = await findAccount(db, tenantId);
  const p = row ? (row.get ? row.get({ plain: true }) : row) : null;
  const connected = !!p && p.status === 'connected';

  return {
    connected,
    status: p?.status || 'disconnected',
    displayPhoneNumber: p?.displayPhoneNumber || null,
    businessName: p?.businessName || null,
    displayName: p?.displayName || null,
    qualityRating: p?.qualityRating || null,
    messagingLimit: p?.messagingLimit || null,
    wabaId: p?.wabaId || null,
    phoneNumberId: p?.phoneNumberId || null,
    connectedAt: p?.connectedAt || null,
    lastSyncAt: p?.lastSyncAt || null,
    // Masked hint only — the decrypted token itself is NEVER returned.
    tokenLast4: p?.accessToken ? last4(decrypt(p.accessToken)) : null,
    needsRegistration: connected ? await detectNeedsRegistration(db, tenantId) : false,
    embedded: getEmbeddedSignupParams(),
  };
}

// ---------------------------------------------------------------------------
// completeSignup — the Embedded Signup callback
// ---------------------------------------------------------------------------

export interface SignupInput {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

/**
 * Finish the Embedded Signup: exchange the popup's code for a business
 * integration token, validate it against the reported WABA, subscribe our app
 * to the WABA webhooks, read the phone details and persist everything
 * (token secretBox-encrypted).
 *
 * NOTE: Cloud API registration (POST /{phoneNumberId}/register with a 2FA PIN)
 * is required before the FIRST send for numbers not yet registered. It is
 * deliberately NOT called here — the PIN is user-provided and only needed when
 * Meta requires it — see registerPhone() (exposed via the /register endpoint).
 */
export async function completeSignup(
  db: any,
  tenantId: string,
  input: SignupInput,
  currentUserId?: string,
) {
  const code = String(input?.code || '').trim();
  const wabaId = String(input?.wabaId || '').trim();
  const phoneNumberId = String(input?.phoneNumberId || '').trim();

  if (!code || !wabaId || !phoneNumberId) {
    throw err400('Faltan datos del registro de WhatsApp (code, wabaId, phoneNumberId).');
  }
  const es = getEmbeddedSignupParams();
  if (!es.configured) {
    throw err400('La plataforma no tiene configurado el registro de WhatsApp (META_APP_ID / META_ES_CONFIG_ID / META_APP_SECRET).');
  }
  const v = es.graphVersion;

  // (a) Exchange the code for a business integration token. JS-SDK Embedded
  //     Signup codes exchange WITHOUT redirect_uri.
  console.log(`[whatsapp] tenant=${tenantId} exchanging Embedded Signup code (waba=${wabaId})`);
  let accessToken = '';
  try {
    const tokenResp = await graphFetch(
      `${GRAPH_BASE}/${v}/oauth/access_token` +
        `?client_id=${encodeURIComponent(es.appId)}` +
        `&client_secret=${encodeURIComponent(process.env.META_APP_SECRET || '')}` +
        `&code=${encodeURIComponent(code)}`,
    );
    accessToken = String(tokenResp?.access_token || '');
  } catch (e: any) {
    console.warn(`[whatsapp] tenant=${tenantId} code exchange failed:`, e?.message || e);
    throw err400(`No se pudo validar el código de Meta: ${e?.message || 'error desconocido'}. Intente conectar de nuevo.`);
  }
  if (!accessToken) {
    throw err400('Meta no devolvió un token de acceso. Intente conectar de nuevo.');
  }

  // (b) Validate the token can access the WABA the popup reported.
  console.log(`[whatsapp] tenant=${tenantId} validating WABA ${wabaId}`);
  let waba: any;
  try {
    waba = await graphFetch(
      `${GRAPH_BASE}/${v}/${encodeURIComponent(wabaId)}?fields=id,name,owner_business_info`,
      { token: accessToken },
    );
  } catch (e: any) {
    console.warn(`[whatsapp] tenant=${tenantId} WABA validation failed:`, e?.message || e);
    throw err400(`El token no tiene acceso a la cuenta de WhatsApp Business indicada: ${e?.message || 'error desconocido'}.`);
  }
  const metaBusinessId = waba?.owner_business_info?.id ? String(waba.owner_business_info.id) : null;
  const businessName =
    (waba?.owner_business_info?.name && String(waba.owner_business_info.name)) ||
    (waba?.name && String(waba.name)) ||
    null;

  // (c) Subscribe our app to the WABA's webhooks (messages, template status,
  //     quality, account updates — the fields are chosen app-side in Meta).
  console.log(`[whatsapp] tenant=${tenantId} subscribing app to WABA ${wabaId} webhooks`);
  try {
    await graphFetch(`${GRAPH_BASE}/${v}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      token: accessToken,
    });
  } catch (e: any) {
    console.warn(`[whatsapp] tenant=${tenantId} subscribed_apps failed:`, e?.message || e);
    throw err400(`No se pudo suscribir la aplicación a los webhooks de WhatsApp: ${e?.message || 'error desconocido'}.`);
  }

  // (d) Phone details. quality_rating may be absent on brand-new numbers.
  console.log(`[whatsapp] tenant=${tenantId} reading phone ${phoneNumberId}`);
  let phone: any;
  try {
    phone = await graphFetch(
      `${GRAPH_BASE}/${v}/${encodeURIComponent(phoneNumberId)}` +
        `?fields=display_phone_number,verified_name,quality_rating`,
      { token: accessToken },
    );
  } catch (e: any) {
    console.warn(`[whatsapp] tenant=${tenantId} phone read failed:`, e?.message || e);
    throw err400(`No se pudo leer el número de WhatsApp: ${e?.message || 'error desconocido'}.`);
  }
  // Throughput / messaging limit — not available on every number/version;
  // best-effort, absence is fine.
  let messagingLimit: string | null = null;
  try {
    const extra = await graphFetch(
      `${GRAPH_BASE}/${v}/${encodeURIComponent(phoneNumberId)}?fields=throughput,messaging_limit_tier`,
      { token: accessToken },
    );
    messagingLimit =
      (extra?.messaging_limit_tier && String(extra.messaging_limit_tier)) ||
      (extra?.throughput?.level && String(extra.throughput.level)) ||
      null;
  } catch {
    messagingLimit = null;
  }

  // (e) Upsert the tenant's account row (token encrypted at rest).
  const now = new Date();
  const values = {
    tenantId,
    metaBusinessId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber: phone?.display_phone_number ? String(phone.display_phone_number).slice(0, 32) : null,
    displayName: phone?.verified_name ? String(phone.verified_name).slice(0, 255) : null,
    businessName: businessName ? businessName.slice(0, 255) : null,
    accessToken: encrypt(accessToken),
    tokenExpiresAt: null, // business integration tokens generally don't expire
    qualityRating: phone?.quality_rating ? String(phone.quality_rating).slice(0, 16) : null,
    messagingLimit: messagingLimit ? messagingLimit.slice(0, 32) : null,
    status: 'connected',
    connectedAt: now,
    disconnectedAt: null,
    connectedByUserId: currentUserId || null,
  };
  const existing = await findAccount(db, tenantId);
  if (existing) await existing.update(values);
  else await db.tenantWhatsappAccount.create(values);
  console.log(
    `[whatsapp] tenant=${tenantId} connected ${values.displayPhoneNumber || phoneNumberId} (waba=${wabaId})`,
  );

  // (f) Best-effort template sync + audit trail — a failure here must not undo
  //     an otherwise successful connection.
  await syncTemplates(db, tenantId).catch((e: any) =>
    console.warn(`[whatsapp] tenant=${tenantId} initial template sync failed:`, e?.message || e),
  );
  await logSecurityEvent(db, {
    tenantId,
    userId: currentUserId || null,
    event: 'whatsapp_connected',
    outcome: 'success',
    detail: values.displayPhoneNumber || phoneNumberId,
  });

  return getStatus(db, tenantId);
}

// ---------------------------------------------------------------------------
// registerPhone — Cloud API registration (2FA PIN), user-initiated
// ---------------------------------------------------------------------------

/**
 * Register the number on the Cloud API (required before the FIRST send for
 * numbers not yet registered). Only called from the /register endpoint with a
 * user-provided 2FA PIN — never automatically.
 */
export async function registerPhone(db: any, tenantId: string, pin: string) {
  const cleanPin = String(pin || '').replace(/\D/g, '');
  if (cleanPin.length !== 6) {
    throw err400('El PIN de registro debe tener 6 dígitos.');
  }
  const cfg = await resolveTenantWhatsappConfig(db, tenantId);
  if (!cfg) {
    throw err400('WhatsApp no está conectado para esta cuenta.');
  }
  console.log(`[whatsapp] tenant=${tenantId} registering phone ${cfg.phoneNumberId} on Cloud API`);
  try {
    await graphFetch(`${GRAPH_BASE}/${cfg.apiVersion}/${encodeURIComponent(cfg.phoneNumberId)}/register`, {
      method: 'POST',
      token: cfg.accessToken,
      body: { messaging_product: 'whatsapp', pin: cleanPin },
    });
  } catch (e: any) {
    console.warn(`[whatsapp] tenant=${tenantId} phone registration failed:`, e?.message || e);
    throw err400(`No se pudo registrar el número en la API de WhatsApp: ${e?.message || 'error desconocido'}.`);
  }
  return { registered: true };
}

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

/**
 * Disconnect the tenant's WhatsApp account. Meta-side unsubscribe is
 * best-effort (the token may already be invalid/revoked) — we ALWAYS
 * disconnect locally and drop the stored token.
 */
export async function disconnect(db: any, tenantId: string, currentUserId?: string) {
  const row = await findAccount(db, tenantId);
  if (!row) {
    throw err400('WhatsApp no está conectado para esta cuenta.');
  }
  const p = row.get ? row.get({ plain: true }) : row;
  const token = decrypt(p.accessToken);
  const v = getEmbeddedSignupParams().graphVersion;

  if (token && p.wabaId) {
    try {
      await graphFetch(`${GRAPH_BASE}/${v}/${encodeURIComponent(p.wabaId)}/subscribed_apps`, {
        method: 'DELETE',
        token,
      });
      console.log(`[whatsapp] tenant=${tenantId} unsubscribed app from WABA ${p.wabaId}`);
    } catch (e: any) {
      // Never throw: local disconnect must always proceed.
      console.warn(`[whatsapp] tenant=${tenantId} Meta unsubscribe failed (continuing):`, e?.message || e);
    }
  }

  await row.update({
    status: 'disconnected',
    accessToken: null,
    disconnectedAt: new Date(),
  });
  console.log(`[whatsapp] tenant=${tenantId} disconnected (${p.displayPhoneNumber || p.phoneNumberId || 'no phone'})`);

  await logSecurityEvent(db, {
    tenantId,
    userId: currentUserId || null,
    event: 'whatsapp_disconnected',
    outcome: 'success',
    detail: p.displayPhoneNumber || p.phoneNumberId || null,
  });

  return getStatus(db, tenantId);
}

// ---------------------------------------------------------------------------
// syncTemplates — mirror the WABA's message templates into whatsappTemplates
// ---------------------------------------------------------------------------

/**
 * Pull the tenant's Meta message templates (name/language/status/category) and
 * upsert them as tenant-scoped whatsappTemplates rows (match on
 * tenantId+name+languageCode). Tenant rows no longer present on the WABA are
 * deactivated. Global (tenantId NULL) seed templates are never touched.
 */
export async function syncTemplates(db: any, tenantId: string) {
  const cfg = await resolveTenantWhatsappConfig(db, tenantId);
  if (!cfg || !cfg.wabaId) {
    throw err400('WhatsApp no está conectado para esta cuenta.');
  }

  const remote: Array<{ name: string; language: string; status: string; category: string }> = [];
  let url: string | null =
    `${GRAPH_BASE}/${cfg.apiVersion}/${encodeURIComponent(cfg.wabaId)}/message_templates` +
    `?fields=name,language,status,category&limit=100`;
  for (let page = 0; page < MAX_TEMPLATE_PAGES && url; page += 1) {
    const resp: any = await graphFetch(url, { token: cfg.accessToken });
    for (const t of Array.isArray(resp?.data) ? resp.data : []) {
      if (t?.name) {
        remote.push({
          name: String(t.name),
          language: String(t.language || 'es'),
          status: String(t.status || '').toUpperCase(),
          category: String(t.category || 'UTILITY').toUpperCase(),
        });
      }
    }
    url = resp?.paging?.next || null;
  }

  const now = new Date();
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const t of remote) {
    seen.add(`${t.name}::${t.language}`);
    const existing = await db.whatsappTemplate.findOne({
      where: { tenantId, name: t.name, languageCode: t.language },
    });
    if (existing) {
      await existing.update({
        category: t.category.slice(0, 20),
        status: t.status.slice(0, 20) || null,
        active: true,
        lastSyncAt: now,
      });
      updated += 1;
    } else {
      await db.whatsappTemplate.create({
        tenantId,
        name: t.name,
        languageCode: t.language,
        category: t.category.slice(0, 20),
        status: t.status.slice(0, 20) || null,
        active: true,
        lastSyncAt: now,
      });
      created += 1;
    }
  }

  // Deactivate tenant rows that no longer exist on the WABA (never global rows).
  let deactivated = 0;
  const tenantRows = await db.whatsappTemplate.findAll({ where: { tenantId } });
  for (const row of tenantRows) {
    const p = row.get ? row.get({ plain: true }) : row;
    if (!seen.has(`${p.name}::${p.languageCode}`) && p.active !== false) {
      await row.update({ active: false, lastSyncAt: now });
      deactivated += 1;
    }
  }

  const account = await findAccount(db, tenantId);
  if (account) await account.update({ lastSyncAt: now });

  console.log(
    `[whatsapp] tenant=${tenantId} template sync: ${remote.length} remote, +${created} / ~${updated} / -${deactivated}`,
  );
  return { total: remote.length, created, updated, deactivated };
}

// ---------------------------------------------------------------------------
// resolveTenantWhatsappConfig — HOT PATH for sends
// ---------------------------------------------------------------------------

export interface TenantWhatsappConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  apiVersion: string;
}

/**
 * Decrypted send credentials for a CONNECTED tenant account, else null. Hot
 * path — one indexed query (unique tenantId) + a decrypt; no Graph calls.
 */
export async function resolveTenantWhatsappConfig(
  db: any,
  tenantId: string,
): Promise<TenantWhatsappConfig | null> {
  if (!db?.tenantWhatsappAccount || !tenantId) return null;
  try {
    const row = await db.tenantWhatsappAccount.findOne({
      where: { tenantId, status: 'connected' },
    });
    if (!row) return null;
    const p = row.get ? row.get({ plain: true }) : row;
    const accessToken = decrypt(p.accessToken);
    if (!accessToken || !p.phoneNumberId) return null;
    return {
      accessToken,
      phoneNumberId: String(p.phoneNumberId),
      wabaId: p.wabaId ? String(p.wabaId) : '',
      apiVersion: process.env.META_WHATSAPP_API_VERSION || 'v21.0',
    };
  } catch (e: any) {
    console.warn('[whatsapp] resolveTenantWhatsappConfig failed:', e?.message || e);
    return null;
  }
}

export default {
  getEmbeddedSignupParams,
  getStatus,
  completeSignup,
  registerPhone,
  disconnect,
  syncTemplates,
  resolveTenantWhatsappConfig,
};
