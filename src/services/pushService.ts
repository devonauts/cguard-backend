/**
 * Push delivery via Firebase Cloud Messaging.
 *
 * Activation: set FIREBASE_SERVICE_ACCOUNT (the service-account JSON, as a string)
 * in the backend env AND `npm i firebase-admin`. Until then every call is a safe
 * no-op (patrol events still create in-app notification rows).
 *
 * The mobile app registers its FCM token via POST /guard/me/device-token, stored
 * in deviceIdInformation; tokens are resolved here per tenant.
 */
let _admin: any = null;
let _initialized = false;

function getAdmin(): any {
  if (_initialized) return _admin;
  _initialized = true;
  try {
    // Accept the service account inline (FIREBASE_SERVICE_ACCOUNT = JSON string)
    // or as a path to the JSON file (FIREBASE_SERVICE_ACCOUNT_FILE).
    let cred: any = null;
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
    const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
    if (inline) {
      cred = typeof inline === 'string' ? JSON.parse(inline) : inline;
    } else if (filePath) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      cred = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      console.warn('[push] no FIREBASE_SERVICE_ACCOUNT(_FILE) set — push disabled (in-app notifications only)');
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require('firebase-admin');
    if (!admin.apps || !admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    }
    _admin = admin;
  } catch (e: any) {
    console.warn('[push] firebase-admin unavailable — push disabled:', e?.message || e);
    _admin = null;
  }
  return _admin;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendToTokens(tokens: string[], payload: PushPayload) {
  const admin = getAdmin();
  const unique = Array.from(new Set((tokens || []).filter(Boolean)));
  if (!admin || unique.length === 0) return { sent: 0, skipped: true };
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens: unique,
      notification: { title: payload.title, body: payload.body },
      data: payload.data || {},
      // High priority so a BACKGROUNDED device wakes and shows the alert promptly
      // (critical for the radio pase — it nudges the guard to open the app).
      android: { priority: 'high', notification: { sound: 'default', priority: 'high', channelId: 'default' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    });
    return { sent: res.successCount, failed: res.failureCount };
  } catch (e: any) {
    console.warn('[push] send failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}

/** Resolve a tenant's registered device tokens and push to them. */
export async function pushToTenant(db: any, tenantId: string, payload: PushPayload) {
  try {
    const rows = await db.deviceIdInformation.findAll({ where: { tenantId } });
    // The FCM token lives in `pushToken`; `deviceId` is a legacy fallback.
    const tokens = (rows || []).map((r: any) => r.pushToken || r.deviceId).filter(Boolean);
    return sendToTokens(tokens, payload);
  } catch (e: any) {
    console.warn('[push] pushToTenant failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}

/** Resolve a single user's registered device tokens and push to them. */
export async function pushToUser(db: any, tenantId: string, userId: string, payload: PushPayload) {
  try {
    if (!userId) return { sent: 0, skipped: true };
    // Device tokens are keyed by the `userId` column (see guardMeDeviceToken) and
    // the FCM token lives in `pushToken`. The old query used `createdById`/
    // `deviceId`, which resolved zero tokens for guards — fixed here.
    const rows = await db.deviceIdInformation.findAll({ where: { tenantId, userId } });
    const tokens = (rows || []).map((r: any) => r.pushToken || r.deviceId).filter(Boolean);
    return sendToTokens(tokens, payload);
  } catch (e: any) {
    console.warn('[push] pushToUser failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}
