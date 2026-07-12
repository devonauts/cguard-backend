# Per-tenant WhatsApp Business — Meta Embedded Signup

Every tenant connects **their own** WhatsApp Business account to CGuardPro via
Meta **Embedded Signup** (Facebook Login for Business). CGuardPro never owns
phone numbers and never pays Meta conversation fees — the tenant's Meta
business does. Official **Meta WhatsApp Business Platform only** (Cloud API +
Embedded Signup); no WhatsApp Web automation of any kind.

## Architecture

- **One account per tenant TODAY.** `tenantWhatsappAccounts` has a **named**
  unique index on `tenantId` (`uniq_tenantWhatsappAccounts_tenantId`). To
  support multiple numbers per tenant later, drop that index (and replace it
  with a plain index) — everything else (webhook routing by `wabaId`, sends by
  `phoneNumberId`) is already multi-number-shaped.
- **Send hot path:** `metaWhatsAppProvider` resolves
  `tenantWhatsappService.resolveTenantWhatsappConfig(db, tenantId)` first (one
  indexed query + decrypt). If the tenant has no connected account, it **falls
  back to the legacy global config** (`communicationSettingsService.getMetaConfig`
  — encrypted platformSettings row / `META_WHATSAPP_*` env) so the current
  global setup keeps working during rollout.
- **Webhook routing:** Meta posts one app-level webhook for all tenants;
  `entry.id` is the WABA id → `tenantWhatsappAccounts.wabaId` → tenant.
- Routing rules, wallet gating and logging are unchanged — they live in
  `messageRouter` / `communicationSettingsService`. The per-tenant work only
  changes *whose credentials* a WhatsApp send uses.

## Meta app prerequisites (platform-level, once)

1. A Meta developer **app** with the **WhatsApp** product added.
2. **Facebook Login for Business** product with a **configuration** of type
   *WhatsApp Embedded Signup* (this yields the `config_id`).
3. App Review / Advanced Access for `whatsapp_business_management` and
   `whatsapp_business_messaging`.
4. Env vars on the backend:
   - `META_APP_ID` — the app id (public, sent to the frontend).
   - `META_APP_SECRET` — used for the code→token exchange **and** webhook HMAC.
   - `META_ES_CONFIG_ID` — the Embedded Signup configuration id (public).
   - `META_WHATSAPP_API_VERSION` — optional, default `v21.0`.
   - `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` — webhook GET verification (existing).

`GET /whatsapp/status` returns `embedded.configured=false` while these are
missing, and the CRM shows a "platform not configured" hint.

## Signup flow

```
CRM (frontend)                     Backend                          Meta Graph API
─ POST …/whatsapp/connect ───────▶ returns {appId, configId,
                                   graphVersion, configured}
─ FB.login(config_id) popup ──────────────────────────────────────▶ user creates/picks
   (Meta JS SDK)                                                     business + WABA + number
◀─ message event: {code, waba_id, phone_number_id} ────────────────┘
─ POST …/whatsapp/callback ──────▶ completeSignup():
   {data:{code,wabaId,              a. GET /oauth/access_token (client_id,
    phoneNumberId}}                    client_secret, code — NO redirect_uri
                                       for JS-SDK codes) → business token
                                    b. GET /{wabaId}?fields=id,name,
                                       owner_business_info  (token validation)
                                    c. POST /{wabaId}/subscribed_apps
                                    d. GET /{phoneNumberId}?fields=
                                       display_phone_number,verified_name,
                                       quality_rating (+ best-effort
                                       throughput/messaging_limit_tier)
                                    e. upsert tenantWhatsappAccounts
                                       (token secretBox-encrypted),
                                       status='connected'
                                    f. syncTemplates (best-effort) +
                                       security-audit 'whatsapp_connected'
◀─ fresh status snapshot ─────────┘
```

## Webhook

Single app-level endpoint (unchanged URL):
`/communications/webhooks/meta/whatsapp` — GET verify + POST with
`X-Hub-Signature-256` HMAC over the raw body (`META_APP_SECRET` /
stored global appSecret). Subscribe the app to these **webhook fields**:

- `messages` — delivery statuses (by globally-unique `wamid`) + inbound
  messages (24h-window tracking; scoped to the WABA's tenant when matched).
- `message_template_status_update` — mirrors APPROVED/REJECTED/PENDING onto the
  tenant's `whatsappTemplates` rows (REJECTED also deactivates).
- `phone_number_quality_update` — updates `qualityRating` (+ `messagingLimit`
  from `current_limit`).
- `account_update` — ban/disable events flag the account `status='error'`.

Every entry is processed best-effort (try/catch per entry); the webhook always
answers 200 on processing errors so Meta doesn't retry-storm.

## Registration PIN caveat

Numbers newly created through Embedded Signup are usually auto-registered, but
a number **not yet registered on the Cloud API** must call
`POST /{phone_number_id}/register` with the business's **two-step verification
PIN** before its first send. This is deliberately **not** automatic (the PIN is
user-knowledge): the status snapshot exposes a best-effort
`needsRegistration` hint (derived from the last failed send looking like Meta
error 133010), and `POST …/whatsapp/register` with `{data:{pin}}` performs the
registration.

## Disconnect semantics

`POST …/whatsapp/disconnect`:
1. Best-effort `DELETE /{wabaId}/subscribed_apps` with the stored token — a
   Meta failure (already-revoked token, deleted WABA) is logged and ignored.
2. **Always** disconnects locally: `status='disconnected'`, `accessToken=NULL`,
   `disconnectedAt=now`, security-audit `whatsapp_disconnected`.
3. Subsequent sends fall back to the legacy global config (if any) or skip
   with `not_configured`.

## Template sync

`POST …/whatsapp/sync-templates` (also runs after connect):
`GET /{wabaId}/message_templates?fields=name,language,status,category&limit=100`
following `paging.next` up to 5 pages. Upserts **tenant-scoped**
`whatsappTemplates` rows (match `tenantId+name+languageCode`), stamping Meta's
review `status` + `lastSyncAt`; tenant rows that vanished from the WABA are set
`active=false`. Global seed templates (`tenantId NULL`) are never touched.

## Security notes

- Tokens are encrypted at rest with `lib/secretBox` (AES-256-GCM) and **never
  leave the backend** — `GET …/whatsapp/status` only exposes `tokenLast4`.
- The code→token exchange happens server-side only; the frontend never sees
  `META_APP_SECRET` or any token.
- All endpoints are tenant-scoped (`/tenant/:tenantId/…`, `settingsRead` /
  `settingsEdit` permissions) and every query filters by `tenantId`.
- connect/disconnect are recorded in the security audit log
  (`whatsapp_connected` / `whatsapp_disconnected`).
