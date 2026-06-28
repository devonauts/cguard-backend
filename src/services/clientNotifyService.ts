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
import { pushToClientAccounts, PushPayload } from './pushService';
import { storePlatformEvent } from '../lib/platformEventStore';

export interface ClientRef {
  clientAccountId?: string | null;
  postSiteId?: string | null;
  stationId?: string | null;
}

export interface ClientRecipients {
  userIds: string[];
  clientAccountIds: string[];
}

/**
 * Collect the distinct client recipients for a site reference: both the clientAccount
 * id(s) (what the client app registers its device with) and any linked user.id(s).
 * Push resolves by either, so delivery no longer depends on clientAccount.userId.
 */
async function resolveClientRecipients(db: any, tenantId: string, ref: ClientRef): Promise<ClientRecipients> {
  const userIds = new Set<string>();
  const clientAccountIds = new Set<string>();

  const addAccount = async (clientAccountId?: string | null) => {
    if (!clientAccountId) return;
    const ca = await db.clientAccount.findOne({
      where: { id: clientAccountId, tenantId, deletedAt: null },
      attributes: ['id', 'userId'],
    });
    if (ca) {
      clientAccountIds.add(ca.id);
      if (ca.userId) userIds.add(ca.userId);
    }
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
      if (st.stationOrigin) {
        clientAccountIds.add(st.stationOrigin.id);
        if (st.stationOrigin.userId) userIds.add(st.stationOrigin.userId);
      }
      if (!postSiteId && st.postSiteId) postSiteId = st.postSiteId;
    }
  }

  if (postSiteId) {
    const bi = await db.businessInfo.findOne({
      where: { id: postSiteId, tenantId, deletedAt: null },
      attributes: ['id'],
      include: [{ model: db.clientAccount, as: 'clientAccount', attributes: ['id', 'userId'], required: false }],
    });
    if (bi && bi.clientAccount) {
      clientAccountIds.add(bi.clientAccount.id);
      if (bi.clientAccount.userId) userIds.add(bi.clientAccount.userId);
    }
  }

  return { userIds: [...userIds], clientAccountIds: [...clientAccountIds] };
}

/**
 * Notify the owning client of a site event. Returns how many client users were
 * notified (0 when there's no linked client). Fire-and-forget friendly.
 */
export async function notifyClient(
  db: any,
  tenantId: string,
  ref: ClientRef,
  opts: { eventType: string; title: string; body: string; data?: Record<string, string>; image?: string; sourceEntityType?: string; sourceEntityId?: string },
): Promise<number> {
  try {
    if (!tenantId) return 0;
    const { userIds, clientAccountIds } = await resolveClientRecipients(db, tenantId, ref);
    if (!userIds.length && !clientAccountIds.length) return 0;
    const payload: PushPayload = {
      title: opts.title,
      body: opts.body,
      data: { ...(opts.data || {}), type: opts.eventType },
      image: opts.image,
    };

    // Single FCM send resolving devices by clientAccountId OR userId (bulletproof,
    // deduped) — delivers even when clientAccount.userId was never linked.
    pushToClientAccounts(db, tenantId, clientAccountIds, userIds, payload).catch(() => {});

    // In-app platform events still need a recipient user id (best-effort).
    for (const uid of userIds) {
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
    return clientAccountIds.length || userIds.length;
  } catch (e: any) {
    console.warn('[clientNotify] failed:', e?.message || e);
    return 0;
  }
}

/**
 * Coverage-change push to the customer who owns a station: a guard ARRIVED
 * (clock-in) or LEFT (clock-out). This is the WORKER-app → customer-app bridge:
 * it resolves the station's owning clientAccount and its registered device(s)
 * via the same bulletproof path as notifyClient (by clientAccountId OR userId),
 * then sends a `coverage`-typed push.
 *
 * Strictly best-effort — never throws — so it can be called fire-and-forget from
 * the clock-in / clock-out handlers without ever affecting the punch flow.
 *
 * @param event   'arrived' | 'left'
 * @param ctx     optional extra labels (stationName, guardId) for the payload.
 */
export async function notifyClientCoverage(
  db: any,
  tenantId: string,
  stationId: string,
  guardId: string | null,
  event: 'arrived' | 'left',
  ctx: { stationName?: string | null; postSiteId?: string | null } = {},
): Promise<number> {
  try {
    if (!tenantId || !stationId) return 0;
    let stationName = ctx.stationName || null;
    let postSiteId = ctx.postSiteId || null;
    if (!stationName || !postSiteId) {
      try {
        const st = await db.station.findOne({
          where: { id: stationId, tenantId, deletedAt: null },
          attributes: ['id', 'stationName', 'postSiteId'],
        });
        if (st) {
          if (!stationName) stationName = st.stationName || null;
          if (!postSiteId) postSiteId = st.postSiteId || null;
        }
      } catch { /* non-fatal */ }
    }
    const label = stationName || 'el puesto';
    const title = event === 'arrived' ? 'Guardia llegó' : 'Guardia salió';
    const body =
      event === 'arrived' ? `Guardia llegó a ${label}.` : `Guardia salió de ${label}.`;

    return await notifyClient(
      db,
      tenantId,
      { stationId, postSiteId },
      {
        eventType: 'coverage',
        title,
        body,
        data: {
          type: 'coverage',
          stationId: String(stationId || ''),
          guardId: String(guardId || ''),
          event,
        },
        sourceEntityType: 'station',
        sourceEntityId: String(stationId || ''),
      },
    );
  } catch (e: any) {
    console.warn('[clientNotify] coverage failed:', e?.message || e);
    return 0;
  }
}
