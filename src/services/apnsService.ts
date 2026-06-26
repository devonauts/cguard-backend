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

let _provider: any = null;
let _initialized = false;

function getProvider(): any {
  if (_initialized) return _provider;
  _initialized = true;
  try {
    const keyPath =
      process.env.APN_KEY_PATH ||
      path.join(__dirname, '..', '..', 'pushNotificationCredentials', 'AuthKey_74XKD54T23.p8');
    if (!fs.existsSync(keyPath)) {
      console.warn('[apns] key file not found — APNs disabled:', keyPath);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apn = require('@parse/node-apn');
    _provider = new apn.Provider({
      token: {
        key: keyPath,
        keyId: process.env.APN_KEY_ID || '74XKD54T23',
        teamId: process.env.APN_TEAM_ID || 'CT355863NH',
      },
      // TestFlight / App Store builds use the PRODUCTION APNs environment.
      production: process.env.APN_PRODUCTION !== 'false',
    });
  } catch (e: any) {
    console.warn('[apns] provider init failed — APNs disabled:', e?.message || e);
    _provider = null;
  }
  return _provider;
}

export interface ApnsPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** True when the .p8 is present and the provider initialised. */
export function isApnsConfigured(): boolean {
  return !!getProvider();
}

/** Send an alert push to raw APNs device tokens. Dedupes; node-apn handles batching. */
export async function sendApns(tokens: string[], payload: ApnsPayload) {
  const provider = getProvider();
  const unique = Array.from(new Set((tokens || []).filter(Boolean)));
  if (!provider || unique.length === 0) return { sent: 0, skipped: true };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apn = require('@parse/node-apn');
    const note = new apn.Notification();
    note.topic = process.env.APN_TOPIC || 'com.miseguridad';
    note.pushType = 'alert';
    note.priority = 10; // deliver immediately
    note.sound = 'default';
    note.alert = { title: payload.title, body: payload.body };
    if (payload.data) note.payload = payload.data;

    const res = await provider.send(note, unique);
    if (res.failed && res.failed.length) {
      console.warn(
        '[apns] failures:',
        res.failed.map((f: any) => ({
          device: String(f.device || '').slice(0, 10),
          status: f.status,
          reason: (f.response && f.response.reason) || (f.error && f.error.message),
        })),
      );
    }
    return { sent: res.sent.length, failed: res.failed.length };
  } catch (e: any) {
    console.warn('[apns] send failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}
