import { pushToTenant } from './pushService';

export const RONDA_DEFAULT_SETTINGS = {
  frequencyMinutes: 60,
  roundsPerShift: null,
  graceMinutes: 10,
  maxDurationMinutes: 60,
  requirePhoto: true,
  requireGeofence: true,
  geofenceRadius: 50,
  requireNote: false,
  notifyTenantOnStart: true,
  notifyTenantOnComplete: true,
  notifyTenantOnMissed: true,
  notifyClient: false,
};

/** Effective ronda settings: per-post override → tenant default → built-in defaults. */
export async function resolveRondaSettings(db: any, tenantId: string, postSiteId?: string | null) {
  try {
    let rec: any = null;
    if (postSiteId) rec = await db.rondaSettings.findOne({ where: { tenantId, postSiteId } });
    if (!rec) rec = await db.rondaSettings.findOne({ where: { tenantId, postSiteId: null } });
    return rec ? { ...RONDA_DEFAULT_SETTINGS, ...rec.get({ plain: true }) } : { ...RONDA_DEFAULT_SETTINGS };
  } catch {
    return { ...RONDA_DEFAULT_SETTINGS };
  }
}

/**
 * Create in-app notification rows for a patrol event (and fire push if configured),
 * gated by the tenant's ronda settings. Best-effort — never throws.
 */
export async function notifyPatrol(
  db: any,
  opts: {
    tenantId: string;
    postSiteId?: string | null;
    event: 'start' | 'complete';
    routeName?: string;
    guardName?: string;
    settings: any;
    createdById?: string;
  },
) {
  try {
    const { tenantId, postSiteId, event, routeName, guardName, settings, createdById } = opts;
    const wantTenant = event === 'start' ? settings.notifyTenantOnStart : settings.notifyTenantOnComplete;
    const wantClient = settings.notifyClient;
    if (!wantTenant && !wantClient) return;

    const title = event === 'start' ? 'Ronda iniciada' : 'Ronda completada';
    const route = routeName ? ` "${routeName}"` : '';
    const body =
      event === 'start'
        ? `${guardName || 'Un guardia'} inició la ronda${route}.`
        : `Ronda${route} completada por ${guardName || 'el guardia'}.`;

    if (wantTenant) {
      try {
        await db.notification.create({
          title,
          body: body.slice(0, 200),
          targetType: 'All',
          deliveryStatus: 'Pending',
          readStatus: false,
          tenantId,
          whoCreatedTheNotificationId: createdById || null,
        });
      } catch (e: any) {
        console.warn('[ronda] tenant notification create failed:', e?.message || e);
      }
      pushToTenant(db, tenantId, { title, body, data: { type: `patrol_${event}` } }).catch(() => {});
    }

    if (wantClient && postSiteId) {
      try {
        const post = await db.businessInfo.findByPk(postSiteId);
        const clientId = post && (post.clientAccountId || post.clientId);
        if (clientId) {
          await db.notification.create({
            title,
            body: body.slice(0, 200),
            targetType: 'Client',
            targetId: String(clientId),
            deliveryStatus: 'Pending',
            readStatus: false,
            tenantId,
            whoCreatedTheNotificationId: createdById || null,
          });
        }
      } catch (e: any) {
        console.warn('[ronda] client notification create failed:', e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[ronda] notifyPatrol failed:', e?.message || e);
  }
}
