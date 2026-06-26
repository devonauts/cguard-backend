/**
 * Direct APNs delivery for the native Mi Seguridad client app (`com.miseguridad`).
 *
 * The native app is NOT on FCM for delivery — it registers its RAW APNs device
 * token (hex) via /customer/me/device-id-information, stored in
 * deviceIdInformation.apnsToken. We push to those tokens straight to Apple with
 * token-based auth (a .p8 APNs Auth Key), exactly like the legacy BAS backend did,
 * which sidesteps the FCM→APNs hop entirely.
 *
 * Auth (env-overridable, sane defaults for prod):
 *   APN_KEY_PATH     path to the .p8 (default: ../../pushNotificationCredentials/AuthKey_74XKD54T23.p8)
 *   APN_KEY_ID       the key id            (default: 74XKD54T23)
 *   APN_TEAM_ID      the Apple team id     (default: CT355863NH)
 *   APN_TOPIC        the bundle id / topic (default: com.miseguridad)
 *   APN_PRODUCTION   'false' to target the APNs sandbox (default: production)
 *
 * If the key file is missing or @parse/node-apn isn't installed, every call is a
 * safe no-op (returns { skipped: true }) — the in-app notification rows still write.
 */
import path from 'path';
import fs from 'fs';

// One provider per APNs environment. A .p8 Auth Key authenticates to BOTH, but a
// device TOKEN is valid in exactly one — production (TestFlight/App Store) or
// sandbox (dev builds from Xcode). We send to the preferred env and fall back to
// the other on BadDeviceToken, so dev and TestFlight devices both deliver.
const _providers: Record<'prod' | 'sandbox', any> = { prod: undefined as any, sandbox: undefined as any };

function getProvider(production: boolean): any {
  const slot: 'prod' | 'sandbox' = production ? 'prod' : 'sandbox';
  if (_providers[slot] !== undefined) return _providers[slot];
  try {
    const keyPath =
      process.env.APN_KEY_PATH ||
      path.join(__dirname, '..', '..', 'pushNotificationCredentials', 'AuthKey_74XKD54T23.p8');
    if (!fs.existsSync(keyPath)) {
      console.warn('[apns] key file not found — APNs disabled:', keyPath);
      _providers[slot] = null;
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apn = require('@parse/node-apn');
    _providers[slot] = new apn.Provider({
      token: {
        key: keyPath,
        keyId: process.env.APN_KEY_ID || '74XKD54T23',
        teamId: process.env.APN_TEAM_ID || 'CT355863NH',
      },
      production,
    });
  } catch (e: any) {
    console.warn('[apns] provider init failed — APNs disabled:', e?.message || e);
    _providers[slot] = null;
  }
  return _providers[slot];
}

/** Preferred environment first (production unless APN_PRODUCTION='false'). */
function preferProduction(): boolean {
  return process.env.APN_PRODUCTION !== 'false';
}

export interface ApnsPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Public HTTPS image URL (e.g. the guard's clock-in selfie). Sets mutable-content
   * so the app's notification-service extension can download + attach it; the URL is
   * also carried in the payload under `image` for the in-app render.
   */
  image?: string;
}

/** True when the .p8 is present and the provider initialised. */
export function isApnsConfigured(): boolean {
  return !!getProvider(preferProduction());
}

/** Send an alert push to raw APNs device tokens. Dedupes; node-apn handles batching.
 *  Tokens rejected as BadDeviceToken (wrong environment) are retried on the other
 *  APNs host so dev (sandbox) and TestFlight (production) builds both deliver. */
export async function sendApns(tokens: string[], payload: ApnsPayload) {
  const unique = Array.from(new Set((tokens || []).filter(Boolean)));
  const prefer = preferProduction();
  const primary = getProvider(prefer);
  if (!primary || unique.length === 0) return { sent: 0, skipped: true };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apn = require('@parse/node-apn');
    const buildNote = () => {
      const note = new apn.Notification();
      note.topic = process.env.APN_TOPIC || 'com.miseguridad';
      note.pushType = 'alert';
      note.priority = 10; // deliver immediately
      note.sound = 'default';
      note.alert = { title: payload.title, body: payload.body };
      note.payload = { ...(payload.data || {}), ...(payload.image ? { image: payload.image } : {}) };
      // mutable-content lets the app's notification-service extension fetch + attach the image.
      if (payload.image) note.mutableContent = 1;
      return note;
    };

    const res = await primary.send(buildNote(), unique);
    let sent = res.sent.length;
    let failures = res.failed || [];

    // Wrong-environment tokens (BadDeviceToken) → retry on the other APNs host.
    const wrongEnv = failures
      .filter((f: any) => (f.response && f.response.reason) === 'BadDeviceToken')
      .map((f: any) => f.device);
    if (wrongEnv.length) {
      const secondary = getProvider(!prefer);
      if (secondary) {
        const res2 = await secondary.send(buildNote(), wrongEnv);
        sent += res2.sent.length;
        // Drop the retried tokens from primary failures; add any that still failed.
        failures = failures
          .filter((f: any) => !wrongEnv.includes(f.device))
          .concat(res2.failed || []);
      }
    }

    if (failures.length) {
      console.warn(
        '[apns] failures:',
        failures.map((f: any) => ({
          device: String(f.device || '').slice(0, 10),
          status: f.status,
          reason: (f.response && f.response.reason) || (f.error && f.error.message),
        })),
      );
    }
    return { sent, failed: failures.length };
  } catch (e: any) {
    console.warn('[apns] send failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}
