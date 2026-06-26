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

/** True when FCM credentials are present and firebase-admin initialised. */
export function isPushConfigured(): boolean {
  return !!getAdmin();
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
    const message = {
      notification: { title: payload.title, body: payload.body },
      data: payload.data || {},
      // High priority so a BACKGROUNDED device wakes and shows the alert promptly
      // (critical for the radio pase — it nudges the guard to open the app).
      android: {
        priority: 'high' as const,
        notification: { sound: 'default', priority: 'high' as const, channelId: 'default', defaultVibrateTimings: true },
      },
      // apns-push-type 'alert' is REQUIRED for an alert push to be delivered on
      // iOS 13+ (FCM omits it otherwise, which silently drops the banner on some
      // builds). apns-priority 10 = deliver immediately. content-available also
      // wakes the app so the in-app popup can refresh from the poll.
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: { aps },
      },
    };
    // FCM caps sendEachForMulticast at 500 tokens/call. Single-tenant/user sends
    // are well under that, but a platform-wide broadcast is not — so chunk and
    // aggregate the counts.
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: batch, ...message });
      sent += res.successCount;
      failed += res.failureCount;
    }
    return { sent, failed };
  } catch (e: any) {
    console.warn('[push] send failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}

/**
 * Deliver to a set of device rows via the RIGHT transport per device, so the two
 * apps each get push through their own channel:
 *   - rows with a raw APNs token  → native Mi Seguridad CLIENT app, direct via APNs (node-apn)
 *   - everything else (pushToken) → WORKER app (+ FCM-based clients) via FCM
 * Split on apnsToken so each physical device is delivered exactly once (no double-send).
 */
async function deliverToDevices(rows: any[], payload: PushPayload) {
  const apnsTokens = (rows || []).map((r: any) => r.apnsToken).filter(Boolean);
  const fcmTokens = (rows || [])
    .filter((r: any) => !r.apnsToken)
    .map((r: any) => r.pushToken || r.deviceId)
    .filter(Boolean);

  const fcmRes: any = await sendToTokens(fcmTokens, payload);

  let apnsRes: any = { sent: 0, skipped: true };
  if (apnsTokens.length) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sendApns } = require('./apnsService');
      apnsRes = await sendApns(apnsTokens, { title: payload.title, body: payload.body, data: payload.data });
    } catch (e: any) {
      console.warn('[push] apns path failed:', e?.message || e);
    }
  }
  return { sent: (fcmRes.sent || 0) + (apnsRes.sent || 0), fcm: fcmRes, apns: apnsRes };
}

/**
 * Worker-app broadcast to a tenant (alarms, rondas, memos, orders, video dispatch).
 * Targets WORKER devices ONLY — client-app (Mi Seguridad) devices are excluded so
 * customers never receive worker events. `app` is stamped at registration; a NULL
 * `app` (legacy rows) is treated as worker.
 */
export async function pushToTenant(db: any, tenantId: string, payload: PushPayload) {
  try {
    const rows = await db.deviceIdInformation.findAll({
      where: { tenantId, [Op.or]: [{ app: { [Op.ne]: 'client' } }, { app: null }] },
    });
    return deliverToDevices(rows, payload);
  } catch (e: any) {
    console.warn('[push] pushToTenant failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}

export type BroadcastApp = 'worker' | 'client';

/** WHERE clause for an app filter (worker counts NULL app as worker; client is explicit). */
function appWhere(app?: BroadcastApp): any {
  if (app === 'worker') return { [Op.or]: [{ app: { [Op.ne]: 'client' } }, { app: null }] };
  if (app === 'client') return { app: 'client' };
  return {};
}

/**
 * Count deliverable devices across ALL tenants, broken down by app + transport, so the
 * superadmin broadcast console can show the blast radius per app.
 *   worker → C-Guard Pro (FCM)   client → Mi Seguridad (APNs, or FCM fallback)
 */
export async function countAllDevices(db: any) {
  try {
    const rows = await db.deviceIdInformation.findAll({
      attributes: ['pushToken', 'deviceId', 'apnsToken', 'app'],
    });
    let worker = 0, client = 0, apns = 0, fcm = 0;
    for (const r of rows || []) {
      const hasApns = !!r.apnsToken;
      const hasFcm = !!(r.pushToken || r.deviceId);
      if (!hasApns && !hasFcm) continue;
      if (r.app === 'client') client++; else worker++;
      if (hasApns) apns++; else fcm++;
    }
    return { total: worker + client, worker, client, apns, fcm };
  } catch (e: any) {
    console.warn('[push] countAllDevices failed:', e?.message || e);
    return { total: 0, worker: 0, client: 0, apns: 0, fcm: 0, error: true };
  }
}

/**
 * Platform-wide broadcast across all tenants — superadmin console only. Routes each
 * device by transport (client APNs token → direct APNs, worker FCM token → FCM) via
 * deliverToDevices, so BOTH apps are reached through their correct channel. `app`
 * optionally restricts to one app ('worker' | 'client'); omit for both.
 */
export async function pushToAll(db: any, payload: PushPayload, app?: BroadcastApp) {
  try {
    const rows = await db.deviceIdInformation.findAll({
      where: appWhere(app),
      attributes: ['pushToken', 'deviceId', 'apnsToken', 'app'],
    });
    const deliverable = (rows || []).filter(
      (r: any) => r.apnsToken || r.pushToken || r.deviceId,
    );
    const result: any = await deliverToDevices(rows, payload);
    return { ...result, devices: deliverable.length };
  } catch (e: any) {
    console.warn('[push] pushToAll failed:', e?.message || e);
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
    // Resolve THIS user's own devices and deliver each via its own transport
    // (a guard's worker device → FCM; a client user's Mi Seguridad device → APNs).
    const rows = await db.deviceIdInformation.findAll({ where: { tenantId, userId } });
    return deliverToDevices(rows, payload);
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

    // Client-app push: resolve the client's devices (the native Mi Seguridad app
    // registers a raw APNs token → delivered direct via APNs; an FCM-based client
    // device → FCM). deliverToDevices routes each to the correct transport.
    const rows = await db.deviceIdInformation.findAll({ where: { tenantId, [Op.or]: or } });
    return deliverToDevices(rows, payload);
  } catch (e: any) {
    console.warn('[push] pushToClientAccounts failed:', e?.message || e);
    return { sent: 0, error: true };
  }
}
