# SuperAdmin Twilio Phone Center

A platform-scoped (NOT per-tenant) phone center for superadmins: a shared SMS
inbox and an in-browser softphone, all driven by a single Twilio number owned by
the platform. SMS and voice events fan out live to every connected superadmin
browser over socket.io.

This document covers the Twilio account setup, the exact webhook/TwiML URLs to
register, env fallbacks, the voice-token flow, the realtime socket events,
signature security, and how to turn it on from the panel.

---

## 1. Architecture at a glance

| Layer | Location |
| --- | --- |
| Platform config (encrypted secrets) | `src/services/twilio/twilioPlatformConfigService.ts` |
| Twilio SDK wrapper (REST, TwiML, tokens, signature) | `src/services/twilio/twilioClient.ts` |
| SMS persistence + realtime | `src/services/twilio/superadminMessagingService.ts` |
| Call persistence + realtime | `src/services/twilio/superadminCallService.ts` |
| Inbound webhooks (root, pre-auth) | `src/api/twilio/webhooks.ts` (mounted in `src/api/index.ts`) |
| SuperAdmin REST routes | `src/api/superadmin/twilio.ts` (mounted by `src/api/superadmin/index.ts`) |
| Realtime fan-out | `src/lib/realtime.ts` → `emitSuperadminEvent`, `'superadmin'` room |
| Models | `src/database/models/twilioConversation.ts`, `twilioMessage.ts`, `twilioCall.ts` |
| SuperAdmin UI | `superadmin/src/pages/phone/PhoneCenter.tsx`, `Softphone.tsx`, `SmsInbox.tsx`, `superadmin/src/pages/settings/TwilioSettingsPage.tsx` |
| SuperAdmin socket client | `superadmin/src/lib/socket.ts` |

The in-browser voice client uses a single shared identity, `superadmin`. An
inbound PSTN call rings every superadmin browser currently registered with that
identity (they all ring; first to answer wins).

---

## 2. Required Twilio setup

You need a Twilio account with:

1. **A phone number** with SMS + Voice capability (purchase or verify/port one).
   This becomes the platform caller ID and the SMS sender.
2. **An API Key (SID + Secret)** — Console → Account → API keys & tokens →
   *Create API key* (Standard). Required for in-browser Voice access tokens.
   The Secret is shown only once; store it in the panel immediately.
3. **A TwiML App** — Console → Voice → TwiML → TwiML Apps → *Create*. Set its
   **Voice Request URL** to the `voice-outbound` webhook below (method POST).
   The TwiML App SID is required for browser-originated outbound calls.
4. The **Account SID** and **Auth Token** (Console dashboard). The Auth Token is
   used both for REST calls and for validating inbound webhook signatures.

---

## 3. Webhook URLs to register in Twilio

Public base URL (verified): `https://api.cguardpro.com`
(`api.cguardpro.com` proxies straight to the app root — there is **no** `/api`
prefix on the webhook paths.) Override with the `TWILIO_PUBLIC_BASE_URL` env var
if the public host differs.

Register these (all **HTTP POST**):

| Purpose | Where to set it in Twilio | URL |
| --- | --- | --- |
| Inbound SMS/MMS | Phone Number → Messaging → *A message comes in* | `https://api.cguardpro.com/communications/webhooks/twilio/sms` |
| SMS delivery status | (optional) status callback for outbound SMS | `https://api.cguardpro.com/communications/webhooks/twilio/sms-status` |
| Inbound voice call | Phone Number → Voice → *A call comes in* | `https://api.cguardpro.com/communications/webhooks/twilio/voice` |
| Call status callback | Phone Number → Voice → *Call status changes* | `https://api.cguardpro.com/communications/webhooks/twilio/voice-status` |
| **TwiML App Voice URL** (browser → PSTN outbound) | TwiML App → *Voice Request URL* | `https://api.cguardpro.com/communications/webhooks/twilio/voice-outbound` |

`voice` and `voice-outbound` return TwiML (`Content-Type: text/xml`); `sms`
returns empty TwiML (we reply from the panel, never auto-reply); the two status
callbacks return `204`.

### Auto-configure button

You do not have to set the **phone number** webhooks by hand. In the panel,
Settings → Twilio → *Numbers* lists the account's incoming numbers and a
**Configure** button POSTs to `/api/superadmin/twilio/numbers/configure`, which
calls `configureNumberWebhooks()` and points that number's SMS + Voice + status
webhooks at the URLs above automatically.

The **TwiML App Voice URL** must still be set manually (or when creating the
TwiML App), since it lives on the app, not the number.

The canonical URL set is produced by `webhookUrls()` in
`src/services/twilio/twilioClient.ts`, so the auto-configure button and the docs
above never drift.

---

## 4. Environment fallback vars

Secrets normally live in the encrypted platform config row managed from the
panel. If a value is absent there, the config service falls back to these env
vars (see `twilioPlatformConfigService.ts`):

| Env var | Maps to |
| --- | --- |
| `TWILIO_MASTER_ACCOUNT_SID` | Account SID |
| `TWILIO_MASTER_AUTH_TOKEN` | Auth Token (REST + webhook signature) |
| `TWILIO_API_KEY_SID` | API Key SID (Voice tokens) |
| `TWILIO_API_KEY_SECRET` | API Key Secret (Voice tokens) |
| `TWILIO_TWIML_APP_SID` | TwiML App SID (browser outbound) |
| `TWILIO_FROM_NUMBER` | Platform phone number / caller ID |
| `TWILIO_MESSAGING_SERVICE_SID` | Messaging Service SID (optional, SMS sender) |
| `TWILIO_PUBLIC_BASE_URL` | Public base for webhook URLs (default `https://api.cguardpro.com`) |

The panel values take precedence; env vars are a deploy-time fallback only.

---

## 5. Voice-token flow (in-browser softphone)

1. The Softphone (`superadmin/src/pages/phone/Softphone.tsx`) calls
   `GET /api/superadmin/twilio/voice-token` (superadmin-gated).
2. The route calls `generateVoiceToken(db, 'superadmin')`
   (`twilioClient.ts`), which builds a short-lived (1h) `AccessToken` JWT signed
   with the **API Key SID/Secret**, attaches a `VoiceGrant`
   (`outgoingApplicationSid = twimlAppSid`, `incomingAllow = true`), and returns
   `{ token, identity }`.
3. The browser hands the JWT to `@twilio/voice-sdk` `Device`. The device
   registers as identity `superadmin`.
4. **Outbound:** the device places a call → Twilio invokes the TwiML App Voice
   URL (`voice-outbound`) → we return `<Dial callerId=PLATFORM_NUMBER>` to the
   `To` param.
5. **Inbound:** a PSTN call hits the number's Voice webhook (`voice`) → we return
   `<Dial><Client>superadmin</Client></Dial>` → every registered superadmin
   browser rings.

Voice tokens require **all** of: API Key SID, API Key Secret, and TwiML App SID.
`generateVoiceToken` throws a clear error if any is missing.

---

## 6. Realtime socket events

Transport: socket.io at path `/api/socket.io`. Superadmins connect with
`tenantId: 'platform'` and the handshake places them in the shared `'superadmin'`
room (`src/lib/realtime.ts`). The backend pushes with `emitSuperadminEvent(event,
payload)`; the frontend subscribes via `useSocketEvent(...)`
(`superadmin/src/lib/socket.ts`). Event names match exactly on both sides:

| Event | Emitted by | Payload | Frontend listener |
| --- | --- | --- | --- |
| `twilio:sms:inbound` | `superadminMessagingService.recordInbound` | `{ conversationId, message }` | `SmsInbox.tsx` |
| `twilio:sms:outbound` | `superadminMessagingService.recordOutbound` | `{ conversationId, message }` | `SmsInbox.tsx` |
| `twilio:sms:status` | `superadminMessagingService.updateMessageStatus` | `{ twilioSid, status }` | `SmsInbox.tsx` |
| `twilio:call:incoming` | `superadminCallService.recordCall` (inbound) | `{ callSid, from }` | `Softphone.tsx` |
| `twilio:call:status` | `superadminCallService.updateCall` | `{ callSid, status, durationSec? }` | `Softphone.tsx` |

---

## 7. Security — webhook signature validation

Every inbound webhook (`src/api/twilio/webhooks.ts`) validates the
`X-Twilio-Signature` header before doing any work:

- `validateSignature(authToken, signature, fullUrl, params)` (in
  `twilioClient.ts`) recomputes the HMAC over the **exact full public URL** plus
  the posted form params using the platform Auth Token.
- The full URL is rebuilt from `TWILIO_PUBLIC_BASE_URL` (default
  `https://api.cguardpro.com`) + `req.originalUrl`, so it must match what Twilio
  signed — keep `TWILIO_PUBLIC_BASE_URL` correct behind proxies.
- On mismatch the handler returns `403` and does nothing.
- If **no** Auth Token is configured, validation is skipped with a console
  warning (so an unconfigured dev/staging environment still works, while prod —
  where the token is set — always enforces).

The webhooks are mounted at the **root**, **before** `authMiddleware`, because
Twilio cannot send a platform JWT; the signature is their authentication. Twilio
POSTs `application/x-www-form-urlencoded`, and the global body parser is
JSON-only, so each webhook route gets a dedicated
`express.urlencoded({ extended: false })` parser in `src/api/index.ts`.

The SuperAdmin REST routes (`/api/superadmin/twilio/*`) sit behind the normal
`authMiddleware` + `requireSuperadmin` gate. Config secrets are write-only: GET
returns only last-4 digits and configured-flags, never the raw secrets.

---

## 8. Enabling it from the panel

1. Sign in to the SuperAdmin panel → sidebar → **Twilio** (Settings) and
   **Teléfono** (the phone center).
2. In **Settings → Twilio**, enter: Account SID, Auth Token, API Key SID, API
   Key Secret, TwiML App SID, the platform phone number, and (optionally) a
   Messaging Service SID. Save.
3. Click **Test** (`POST /settings/twilio/test`) to verify the credentials.
4. Under **Numbers**, click **Configure** on the platform number to auto-point
   its SMS/Voice/status webhooks at this backend.
5. Manually set the **TwiML App Voice URL** to the `voice-outbound` URL (§3).
6. Open **Teléfono**: the SMS inbox loads conversations, and the softphone
   fetches a voice token and registers. Inbound SMS/calls now appear live.

---

## 9. Human TODO checklist

- [ ] Purchase or verify/port a Twilio **phone number** with SMS + Voice.
- [ ] Create a Twilio **API Key** (SID + Secret) for Voice tokens — copy the
      Secret immediately (shown once).
- [ ] Create a **TwiML App** and set its Voice Request URL to
      `https://api.cguardpro.com/communications/webhooks/twilio/voice-outbound`.
- [ ] Enter Account SID, Auth Token, API Key SID/Secret, TwiML App SID, and the
      phone number in **Settings → Twilio** (or set the `TWILIO_*` env fallbacks).
- [ ] Run **Numbers → Configure** to auto-register the number's webhooks (or set
      them manually per §3).
- [ ] Confirm `TWILIO_PUBLIC_BASE_URL` is correct if the public host is not
      `https://api.cguardpro.com` (required for signature validation).
- [ ] Run the 3 Twilio migrations on the target DB
      (`z20260617a/b/c-create-twilio-*`).
