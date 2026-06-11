/**
 * Client (clientAccount) push notifications for site activity:
 *   - patrol/ronda completed
 *   - guard clock-in (shift start) / clock-out (shift end)
 *   - incident created
 *
 * Resolves the owning client of a post-site/station → its user.id, then sends an
 * FCM push (pushToUser) plus an in-app platform event scoped to that client
 * (recipientUserId, so it never reaches staff/admin feeds). The client app
 * registers its device token via POST /customer/device-token (keyed by
 * clientAccount.userId), so pushToUser delivers to it.
 *
 * Best-effort: never throws and never blocks the originating request. No-op when
 * FCM isn't configured or the post-site has no linked client / device token.
 *
 * Resolution uses associations (not raw FK names): station → `stationOrigin`
 * (clientAccount) and station.postSiteId → businessInfo → `clientAccount`.
 */
import { pushToUser, PushPayload } from './pushService';
import { storePlatformEvent } from '../lib/platformEventStore';

export interface ClientRef {
  clientAccountId?: string | null;
  postSiteId?: string | null;
  stationId?: string | null;
}

/** Collect the distinct client user.id(s) to notify for a given site reference. */
async function resolveClientUserIds(db: any, tenantId: string, ref: ClientRef): Promise<string[]> {
  const userIds = new Set<string>();

  const addAccount = async (clientAccountId?: string | null) => {
    if (!clientAccountId) return;
    const ca = await db.clientAccount.findOne({
      where: { id: clientAccountId, tenantId, deletedAt: null },
      attributes: ['id', 'userId'],
    });
    if (ca && ca.userId) userIds.add(ca.userId);
  };

  await addAccount(ref.clientAccountId);

  let postSiteId = ref.postSiteId || null;

  if (ref.stationId) {
    const st = await db.station.findOne({
      where: { id: ref.stationId, tenantId, deletedAt: null },
      attributes: ['id', 'postSiteId'],
      include: [{ model: db.clientAccount, as: 'stationOrigin', attributes: ['id', 'userId'], required: false }],
    });
    if (st) {
      if (st.stationOrigin && st.stationOrigin.userId) userIds.add(st.stationOrigin.userId);
      if (!postSiteId && st.postSiteId) postSiteId = st.postSiteId;
    }
  }

  if (postSiteId) {
    const bi = await db.businessInfo.findOne({
      where: { id: postSiteId, tenantId, deletedAt: null },
      attributes: ['id'],
      include: [{ model: db.clientAccount, as: 'clientAccount', attributes: ['id', 'userId'], required: false }],
    });
    if (bi && bi.clientAccount && bi.clientAccount.userId) userIds.add(bi.clientAccount.userId);
  }

  return [...userIds];
}

/**
 * Notify the owning client of a site event. Returns how many client users were
 * notified (0 when there's no linked client). Fire-and-forget friendly.
 */
export async function notifyClient(
  db: any,
  tenantId: string,
  ref: ClientRef,
  opts: { eventType: string; title: string; body: string; data?: Record<string, string>; sourceEntityType?: string; sourceEntityId?: string },
): Promise<number> {
  try {
    if (!tenantId) return 0;
    const userIds = await resolveClientUserIds(db, tenantId, ref);
    if (!userIds.length) return 0;
    const payload: PushPayload = {
      title: opts.title,
      body: opts.body,
      data: { ...(opts.data || {}), type: opts.eventType },
    };
    for (const uid of userIds) {
      pushToUser(db, tenantId, uid, payload).catch(() => {});
      storePlatformEvent(db, {
        tenantId,
        eventType: opts.eventType,
        title: opts.title,
        body: opts.body,
        recipientUserId: uid,
        payload: opts.data || null,
        sourceEntityType: opts.sourceEntityType,
        sourceEntityId: opts.sourceEntityId,
      }).catch(() => {});
    }
    return userIds.length;
  } catch (e: any) {
    console.warn('[clientNotify] failed:', e?.message || e);
    return 0;
  }
}
