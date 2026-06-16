# Unified Communications Layer

CGuard Pro's single outbound-messaging layer. **Nothing in the app calls
Twilio / Meta / Firebase / SendGrid directly anymore** — everything goes through
`CommunicationService` (`src/services/communication/communicationService.ts`),
which routes each message across channels, wallet-gates the paid ones, and logs
every attempt.

> TL;DR channel order (free → paid): **PUSH** (Firebase, free) → **WhatsApp**
> (Meta Cloud API, ~1¢) → **SMS** (Twilio, fallback only, ~5¢) → **Email**
> (free, opt-in). Push and email are never wallet-gated; WhatsApp and SMS debit a
> per-tenant `communicationWallet` before sending.

---

## Contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Environment variables](#environment-variables)
3. [Configuring Meta WhatsApp Cloud API](#configuring-meta-whatsapp-cloud-api)
4. [Webhook setup](#webhook-setup)
5. [WhatsApp templates](#whatsapp-templates)
6. [Routing rules](#routing-rules)
7. [Wallet, billing & cost tracking](#wallet-billing--cost-tracking)
8. [Twilio SMS fallback](#twilio-sms-fallback)
9. [Admin API](#admin-api)
10. [Using the facade from app code](#using-the-facade-from-app-code)
11. [Running the tests](#running-the-tests)
12. [Troubleshooting](#troubleshooting)

---

## Architecture at a glance

```
app code
   │  CommunicationService.sendIncidentAlert(db, {...})
   ▼
MessageRouter.route(db, intent)
   │   1. resolve recipients (userId → push token / phone / email)
   │   2. build the channel plan from the routing rules
   │   3. for each channel:  enabled? → configured? → wallet ok? → send → debit → LOG
   ▼
Providers (each implements CommunicationProvider)
   ├─ pushProvider        → wraps src/services/pushService.ts        (Firebase FCM)
   ├─ metaWhatsAppProvider → Meta Graph API  (graph.facebook.com)
   ├─ twilioSmsProvider   → low-level Twilio (tenant subaccount)
   └─ emailProvider       → wraps src/services/mailService.ts        (SendGrid/SMTP)
```

Key files (all under `src/services/communication/`):

| File | Responsibility |
|---|---|
| `types.ts` | Shared enums + interfaces (the integration contract). |
| `communicationService.ts` | The **facade** — typed wrappers app code calls. |
| `messageRouter.ts` | Channel selection, cascade, wallet gate, debit, logging. |
| `communicationSettingsService.ts` | Per-tenant settings, wallet, rates, Meta creds. |
| `communicationLogService.ts` | The only reader/writer of `communicationLogs`. |
| `whatsappSessionService.ts` | Meta 24h customer-service window tracking. |
| `phone.ts` | E.164 normalization. |
| `providers/*.ts` | One file per channel. |
| `../../api/communication/metaWebhook.ts` | Public Meta webhook (GET verify + POST). |
| `../../api/communication/communicationEndpoints.ts` | Authed admin routes. |

**Non-breaking guarantee:** the providers *wrap* the existing services
(`pushService`, `smsAccountService`, `mailService`) — the legacy
`pushToUser`/`pushToTenant`, `sendSmsForTenant`, `notificationDispatcher.dispatch`
and the legacy `tenantSmsAccount` wallet all keep working unchanged.

---

## Environment variables

### Meta WhatsApp Cloud API

| Variable | Required | Default | Notes |
|---|---|---|---|
| `META_WHATSAPP_ACCESS_TOKEN` | yes* | — | System-user permanent token. |
| `META_WHATSAPP_PHONE_NUMBER_ID` | yes* | — | The WABA phone-number id (not the phone number). |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID` | recommended | — | WABA id (template management). |
| `META_WHATSAPP_API_VERSION` | no | `v20.0` | Graph API version. |
| `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` | yes (for webhook) | — | Any random string; must match the value entered in the Meta dashboard. |
| `META_APP_SECRET` | recommended | — | When set, inbound POST webhooks are HMAC-verified. |

\* Credentials may instead be stored **encrypted in the DB** via the SuperAdmin
panel (`platformSettings` key `whatsapp`, encrypted with `src/lib/secretBox.ts`).
`getMetaConfig()` prefers the DB value and falls back to env (mirrors
`stripeConfigService`). Secrets are **never** exposed to the frontend — the panel
only ever sees a masked getter (`getMetaConfigMasked`).

### Twilio SMS (unchanged from the legacy stack)

Twilio is provisioned per tenant via `smsAccountService` (master account +
per-tenant subaccount + sender). The relevant platform env vars are unchanged:

| Variable | Notes |
|---|---|
| `TWILIO_MASTER_ACCOUNT_SID` / `TWILIO_ACCOUNT_SID` | Master account. |
| `TWILIO_AUTH_TOKEN` | Master auth token. |
| (per-tenant subaccount SID/token, sender, `messagingServiceSid`) | Stored encrypted on `tenantSmsAccount`. |

### Email & Push (wrapped, unchanged)

| Variable | Notes |
|---|---|
| `SENDGRID_API_KEY` **or** `MAIL_SERVER` | Email transport (one required to enable email). |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase admin credentials for FCM push. |
| `SETTINGS_ENC_KEY` (or `AUTH_JWT_SECRET`) | Key material for `secretBox` secret encryption. |

---

## Configuring Meta WhatsApp Cloud API

1. **Create a Meta app** at <https://developers.facebook.com> → add the
   **WhatsApp** product. This gives you a test number + a WhatsApp Business
   Account (WABA).
2. **Add a production phone number** to the WABA and verify it. Note its
   **Phone number ID** (Graph requires the *id*, not the human number).
3. **Create a System User** (Business Settings → Users → System Users) with the
   `whatsapp_business_messaging` + `whatsapp_business_management` permissions and
   generate a **permanent access token**. Put it in `META_WHATSAPP_ACCESS_TOKEN`
   (or save it encrypted via the SuperAdmin panel).
4. **Set the env vars** above (or the encrypted DB config) and restart PM2.
5. **Verify connectivity:** `GET /tenant/:tenantId/communications/wallet` and the
   admin settings endpoint should succeed; `isMetaConfigured()` returns true once
   `accessToken` + `phoneNumberId` are present.
6. **Enable the channel per tenant:** WhatsApp is **off by default**
   (`whatsapp_enabled: false`). Turn it on via
   `PUT /tenant/:tenantId/communications/settings`.

---

## Webhook setup

**Webhook URL:** `https://<your-host>/api/communications/webhooks/meta/whatsapp`
(the route is mounted **before** auth middleware in `src/api/index.ts`; it is
public by design).

### GET — verification handshake

When you save the webhook in the Meta dashboard, Meta calls:

```
GET .../meta/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<n>
```

The handler echoes `hub.challenge` **only** when `hub.verify_token` equals the
configured `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` (or the DB-stored value);
otherwise it returns `403`. Set the **Verify Token** field in the dashboard to
the exact same string as `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

### POST — status + inbound callbacks

- **Signature:** when `META_APP_SECRET` is set, every POST is HMAC-SHA256-verified
  against the raw body via the `X-Hub-Signature-256` header (constant-time
  compare). A bad signature → `403`. When the secret is **not** set (dev/sandbox),
  the check is skipped.
- **Delivery statuses** (`sent`/`delivered`/`read`/`failed`) are mapped and
  applied to the matching `communicationLogs` row by `providerMessageId`
  (`updateStatusByProviderMessageId`), stamping `deliveredAt`/`readAt`/`failedAt`.
- **Inbound messages** record `lastInboundAt` per (tenant, phone) in
  `whatsappInboundSessions`, which opens Meta's **24-hour customer-service
  window** so the WhatsApp provider may send free-form text (otherwise it must use
  a template).
- The handler **always responds 200 quickly** (even on internal error) so Meta
  does not enter a retry storm; failures are logged server-side.

In the Meta dashboard, **subscribe** the webhook to the `messages` field of the
WhatsApp product.

---

## WhatsApp templates

Outside the 24h window, Meta only delivers **pre-approved templates** (free-form
text is rejected). OTP must **always** use an `AUTHENTICATION` template — never
free-form text. Templates are seeded into `whatsappTemplates`
(`tenantId NULL` = global default) and must also be **created + approved in the
Meta dashboard** under WhatsApp Manager → Message templates.

The router maps `messageType` → template name:

| messageType | Template name | Category | Body params |
|---|---|---|---|
| `otp` | `otp_code` | AUTHENTICATION | 1 (the code) |
| `shift_reminder` | `shift_reminder` | UTILITY | per template |
| `new_assignment` | `new_assignment` | UTILITY | per template |
| `incident_alert` | `incident_alert` | UTILITY | per template |
| `ronda_alert` | `missed_checkpoint` | UTILITY | per template |
| `no_show` | `no_show_alert` | UTILITY | per template |
| `visitor_alert` | `visitor_arrived` | UTILITY | per template |
| `task_alert` | `task_assigned` | UTILITY | per template |
| `panic` | `panic_alert` | UTILITY | per template |

> **Meta approval note:** template names + languages must match **exactly** what
> Meta approved, or the send fails with a template-not-found error. New templates
> take minutes-to-hours to approve. `UTILITY`/`AUTHENTICATION` templates can be
> business-initiated any time; `MARKETING` templates are subject to extra limits.
> Body parameters are positional — `templateVars` keys `'1'`, `'2'`, … map in
> numeric order to the template's `{{1}}`, `{{2}}` placeholders.

---

## Routing rules

Implemented in `messageRouter.ts` (`buildChannelPlan` + `stopAfterSuccess`).

- **Non-critical operational** (`generic`, `task_alert`, `new_assignment`,
  `no_show` when not critical): **push first**; if no device token / push
  unavailable → **WhatsApp** (if enabled + wallet ok); → **SMS** only if
  important + enabled + wallet ok. **Stops at the first delivered channel** (push
  wins → we don't also pay for WhatsApp/SMS).
- **Critical** (`incident_alert`, `escalation`, etc.): **push + WhatsApp fan out**
  (no early stop); SMS added when `critical_alert_sms_fallback` is on.
- **Panic / emergency** (`panic`): **push + WhatsApp + SMS immediately**, all of
  them, no early stop.
- **OTP** (`otp`): **WhatsApp `AUTHENTICATION` template** if
  `otp_preferred_channel='whatsapp'` and enabled, else **SMS**. Never push, never
  free-form WhatsApp. Stops at the first delivered channel.
- **Visitor** (`visitor_alert`): push first; WhatsApp only if `whatsapp_incidents`
  is on; SMS only if the critical SMS fallback is on.
- **Shift reminder** (`shift_reminder`): push first; WhatsApp if the guard has
  **no push token** OR `whatsapp_shift_reminders` is on; SMS only as a last-ditch
  fallback.
- **Incident** (`incident_alert`): push + WhatsApp to supervisors/admins
  (the caller targets the recipient); include title, site, guard, severity,
  deep link.
- **Ronda missed checkpoint** (`ronda_alert`): push + WhatsApp to supervisor; SMS
  only if `sms_critical`.

**Cross-cutting:**

- A channel is only attempted if it has a recipient handle (push needs a
  `userId`; whatsapp/sms need a phone; email needs an address).
- **Wallet gate:** before any paid (whatsapp/sms) send, if
  `wallet_required_for_paid_channels` and the balance is insufficient and **not**
  (`critical` && `allow_negative_communications_balance`) → **skip + log
  `status:'skipped'`, reason `insufficient_balance`**. Push/email are never
  wallet-blocked.
- An **invalid/missing push token** is marked inactive in `deviceIdInformation`;
  it does not auto-fallback except where a rule says so.

**Deep links:** `cguardpro://incidents/:id`, `/shifts/:id`, `/visitors/:id`,
`/rondas/:id`, `/tasks/:id`, `/messages/:id`.

---

## Wallet, billing & cost tracking

Each tenant has one row in `communicationWallets`
(`balanceCents`, `currency`, `lowBalanceThresholdCents`). The migration seeds it
from the legacy `tenantSmsAccount.balanceCents` where present.

- **Debits are atomic** (`debitWallet` — DB transaction + row lock) and refuse to
  go negative unless `allow_negative_communications_balance` (or an explicit
  critical override) is set. **Only the router debits** — providers never touch
  the wallet (prevents the double-debit the legacy SMS path would otherwise
  cause).
- **Cost estimation** (`estimateCost`) reads `communicationProviderRates`,
  matching the most-specific active rate for `(provider, channel)` by country +
  messageType (exact match beats `*` wildcard), then applies `markupPercentage`
  (pass-through + markup). No matching rate → **free** (0¢). Seeded defaults:
  SMS ≈ 5¢, WhatsApp UTILITY ≈ 1¢, push 0¢, email 0¢.
- Every attempt is logged to `communicationLogs` with `costEstimateCents` and, on
  a successful paid send, `billedAmountCents`. **`communicationLogs` is the
  ledger** — sum `billedAmountCents` per tenant/period for cost reporting.
- **Low balance:** `getWallet().belowThreshold` flags when
  `balanceCents < lowBalanceThresholdCents` (default 500¢ / $5) so the panel can
  prompt a recharge.

### Cost tracking vs the $5/user license

The product license is **$5 per guard/user per month**. WhatsApp/SMS spend is a
**separate prepaid wallet** that does not come out of the license — it's tracked
independently so you can see, per tenant, how much messaging actually costs vs the
license revenue:

- License revenue (per tenant) = active users × $5.
- Messaging cost (per tenant) = `SUM(communicationLogs.billedAmountCents)` over
  the period.
- Because **push and email are free** and the router always tries push first,
  the *typical* operational alert costs **0¢** — paid channels only fire on
  fallback or critical fan-out, keeping messaging spend well under the license
  margin. Use the logs feed to confirm a tenant isn't unexpectedly leaning on
  WhatsApp/SMS (e.g. guards with no push token).

---

## Twilio SMS fallback

SMS is the **last-resort** channel. The `twilioSmsProvider` deliberately does a
**low-level** Twilio send using the tenant's already-provisioned subaccount +
sender (reusing `getAccount` / `ensureLocalAccount` / `subaccountClient` from
`smsAccountService`) and leaves **all** wallet movement to the router. It does
**not** call the legacy `sendSmsForTenant` and does **not** touch the legacy
`tenantSmsAccount` wallet — otherwise a tenant would be billed twice (once per
wallet). The legacy SMS stack remains fully functional for its existing callers.

SMS only fires when a routing rule says so (critical fallback, OTP without
WhatsApp, etc.) **and** `sms_enabled` is on **and** the wallet covers it.

---

## Admin API

Authed, tenant-scoped (mounted after auth middleware):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tenant/:tenantId/communications/settings` | Current merged settings. |
| `PUT` | `/tenant/:tenantId/communications/settings` | Patch settings (merged over existing). |
| `GET` | `/tenant/:tenantId/communications/logs` | Paginated, tenant-scoped log feed. Filters: `channel`, `provider`, `status`, `type`/`messageType`, `from`, `to`, `page`, `limit`. |
| `GET` | `/tenant/:tenantId/communications/wallet` | Wallet snapshot (`balanceCents`, threshold, `belowThreshold`). |

Public (no auth, mounted before auth middleware):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/communications/webhooks/meta/whatsapp` | Meta verification handshake. |
| `POST` | `/communications/webhooks/meta/whatsapp` | Status + inbound callbacks. |

---

## Using the facade from app code

Import the facade and call a typed method — **do not** import Twilio/Meta/Firebase
or the providers directly:

```ts
import CommunicationService from '../services/communication/communicationService';

// Incident → push + WhatsApp to a supervisor (router decides channels + order):
await CommunicationService.sendIncidentAlert(db, {
  tenantId,
  userId: supervisorUserId,   // resolves push token + phone
  title: 'Incidente: intrusión',
  body: 'Sitio Norte — guardia Juan Pérez — severidad alta',
  incidentId,                 // becomes cguardpro://incidents/:id
  critical: true,
});

// OTP → WhatsApp AUTHENTICATION template (or SMS fallback). Returns the code.
const { code, results } = await CommunicationService.sendOtp(db, { tenantId, phone });
```

Public facade methods (signatures are the contract — see
`communicationService.ts`): `sendPushNotification`, `sendWhatsAppMessage`,
`sendSms`, `sendEmail`, `sendOperationalAlert`, `sendOtp`, `sendShiftReminder`,
`sendIncidentAlert`, `sendVisitorAlert`, `sendRondaAlert`, `sendNoShowAlert`,
`sendTaskAssignedAlert`, `sendEscalationAlert`. Each returns `SendResult[]` (one
per channel attempted).

---

## Running the tests

The communications test suite lives at
`src/services/communication/__tests__/routing.test.ts` (with a bridge at
`tests/unit/communication/routing.test.ts` so the fast unit glob also picks it
up). It exercises the **real** router / settings / wallet / log services against
an in-memory fake `db` (no MySQL, no network); only the provider transports are
stubbed with sinon.

```bash
# Fast unit suite (tests/unit/**) — includes the communications suite via the bridge:
npm run test:unit

# Full suite (tests/** + src/** /*.test.ts):
npm test

# Just the communications suite:
npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
  mocha -r ts-node/register \
  'src/services/communication/__tests__/routing.test.ts' --exit --timeout 10000
```

What's covered: push-first routing, WhatsApp fallback, SMS fallback,
critical multi-channel fan-out, wallet-insufficient blocking a non-critical paid
send (+ the critical `allow_negative` override), the per-send wallet debit, OTP
WhatsApp-preferred + SMS fallback, missing-credentials graceful skip,
channel-disabled skip, Meta webhook GET verification (challenge + 403),
POST signature verification (HMAC), status→log mapping, Twilio SMS still working
(no double-debit), tenant isolation + filtering on the log feed, and phone
normalization edge cases.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Webhook GET returns 403 | `hub.verify_token` ≠ `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` (check the dashboard field and restart PM2 after changing env). |
| Webhook POST returns 403 | `X-Hub-Signature-256` doesn't match `META_APP_SECRET`. Confirm the secret matches the Meta app and that the **raw body** reaches the handler (`req.rawBody`). |
| WhatsApp logged `skipped: not_configured` | `accessToken` or `phoneNumberId` missing — set env or the encrypted DB config. |
| WhatsApp logged `skipped: outside_24h_window_no_template` | No recent inbound from the recipient and no template name — supply an approved template (`templateName`) for business-initiated sends. |
| WhatsApp logged `skipped: otp_requires_template` | OTP was attempted without an AUTHENTICATION template — always pass `otp_code` (the `sendOtp` facade does this). |
| Send logged `skipped: insufficient_balance` | Wallet too low for the estimated cost. Recharge (`creditWallet`) or, for criticals, enable `allow_negative_communications_balance`. |
| WhatsApp send fails with template error | Template name/language not approved in Meta, or param count mismatch. Match the approved template exactly. |
| SMS never fires | `sms_enabled` off, no provisioned Twilio subaccount/sender for the tenant, or no routing rule selected SMS (it's fallback-only). |
| Push logged `skipped: no_token` | User has no active `deviceIdInformation.pushToken` — the router falls through to WhatsApp/SMS per the rule. |
| Status callbacks never update logs | Webhook not subscribed to the `messages` field, or the `providerMessageId` (`wamid…`) wasn't captured on send. |
| Tenant double-billed for SMS | Should not happen — the unified provider does **not** call `sendSmsForTenant`. If it does, a caller bypassed the facade; route through `CommunicationService` instead. |
| Logs show another tenant's rows | Should not happen — all log queries are tenant-scoped. File a bug; check the caller passed the right `tenantId`. |
