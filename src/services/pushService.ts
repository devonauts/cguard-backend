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
import { Op } from 'sequelize';

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
  /**
   * Mark the alert as time-sensitive (iOS) / max priority (Android). This lets it
   * break through Focus / Do-Not-Disturb and lights the screen immediately — used
   * for the pase de novedades, where the guard only has ~1 minute to respond.
   * Requires the `com.apple.developer.usernotifications.time-sensitive`
   * entitlement on the iOS app (added to App.entitlements).
   */
  timeSensitive?: boolean;
}

export async function sendToTokens(tokens: string[], payload: PushPayload) {
  const admin = getAdmin();
  const unique = Array.from(new Set((tokens || []).filter(Boolean)));
  if (!admin || unique.length === 0) return { sent: 0, skipped: true };
  try {
    const aps: Record<string, any> = { sound: 'default' };
    // Time-sensitive interruption level pierces Focus modes and shows even when
    // the phone is locked/silenced (iOS 15+). Falls back gracefully on older iOS.
    if (payload.timeSensitive) aps['interruption-level'] = 'time-sensitive';
    const res = await admin.messaging().sendEachForMulticast({
      tokens: unique,
      notification: { title: payload.title, body: payload.body },
      data: payload.data || {},
      // High priority so a BACKGROUNDED device wakes and shows the alert promptly
      // (critical for the radio pase — it nudges the guard to open the app).
      android: {
        priority: 'high',
        notification: { sound: 'default', priority: 'high', channelId: 'default', defaultVibrateTimings: true },
      },
      // apns-push-type 'alert' is REQUIRED for an alert push to be delivered on
      // iOS 13+ (FCM omits it otherwise, which silently drops the banner on some
      // builds). apns-priority 10 = deliver immediately. content-available also
      // wakes the app so the in-app popup can refresh from the poll.
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: { aps },
      },
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

/**
 * Bulletproof customer push: resolve device tokens by `clientAccountId` (what the
 * client app registers with) OR `userId`, deduped, and send once. Works even when
 * `clientAccount.userId` was never linked.
 */
export async function pushToClientAccounts(
  db: any,
  tenantId: string,
  clientAccountIds: string[],
  userIds: string[],
  payload: PushPayload,
) {
  try {
    const cas = Array.from(new Set((clientAccountIds || []).filter(Boolean)));
    const uids = Array.from(new Set((userIds || []).filter(Boolean)));
    if (!cas.length && !uids.length) return { sent: 0, skipped: true };

    const or: any[] = [];
    if (cas.length) or.push({ clientAccountId: { [Op.in]: cas } });
    if (uids.length) or.push({ userId: { [Op.in]: uids } });

    const rows = await db.deviceIdInformation.findAll({ where: { tenantId, [Op.or]: or } });
    const tokens = (rows || []).map((r: any) => r.pushToken || r.deviceId).filter(Boolean);
    return sendToTokens(tokens, payload);
  } catch (e: any) {
    console.warn('[push] pushToClientAccounts failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}
