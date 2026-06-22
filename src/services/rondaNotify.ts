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
  emailOnComplete: false,
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

/** Emails of the tenant's admins/supervisors — who should hear about patrols. */
async function resolveTenantNotifyEmails(db: any, tenantId: string): Promise<string[]> {
  try {
    const targetRoles = ['admin', 'owner', 'operationsManager', 'securitySupervisor', 'dispatcher'];
    const tenantUsers = await db.tenantUser.findAll({
      where: { tenantId },
      include: [{ model: db.user, as: 'user', attributes: ['email'] }],
    });
    const emails = new Set<string>();
    for (const tu of tenantUsers || []) {
      const roles = Array.isArray(tu.roles)
        ? tu.roles
        : typeof tu.roles === 'string'
          ? tu.roles.split(',').map((r: string) => r.trim())
          : [];
      if (!roles.some((r: string) => targetRoles.includes(r))) continue;
      const u = tu.user;
      if (u && u.email) emails.add(u.email);
    }
    return Array.from(emails);
  } catch {
    return [];
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
    const wantEmail = event === 'complete' && !!settings.emailOnComplete;
    if (!wantTenant && !wantClient && !wantEmail) return;

    const title = event === 'start' ? 'Ronda iniciada' : 'Ronda completada';
    const route = routeName ? ` "${routeName}"` : '';
    const body =
      event === 'start'
        ? `${guardName || 'Un guardia'} inició la ronda${route}.`
        : `Ronda${route} completada por ${guardName || 'el guardia'}.`;

    if (wantTenant) {
      // PRIMARY CRM delivery: the CRM notification feed (bell) reads the
      // platform_events stream over websockets — NOT the legacy `notifications`
      // table. storePlatformEvent persists the row (bell backlog) AND emits it
      // live to the tenant's connected browsers. Without this, ronda events
      // never reached the CRM. targetRoles=null → broadcast to the whole tenant.
      try {
        const { storePlatformEvent } = require('../lib/platformEventStore');
        await storePlatformEvent(db, {
          tenantId,
          eventType: event === 'start' ? 'patrol.started' : 'patrol.completed',
          title,
          body: body.slice(0, 200),
          payload: { routeName: routeName || null, guardName: guardName || null, postSiteId: postSiteId || null },
          targetRoles: null,
          sourceEntityType: 'siteTour',
          sourceEntityId: postSiteId || null,
        });
      } catch (e: any) {
        console.warn('[ronda] platform event emit failed:', e?.message || e);
      }
      // Legacy in-app row (kept for any consumers of the notifications table).
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

      // Email the tenant's admins/supervisors. mailService throws when no transport
      // is configured, so this naturally only sends "if configured".
      try {
        const emails = await resolveTenantNotifyEmails(db, tenantId);
        if (emails.length) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { sendMail } = require('./mailService');
          const html =
            `<p style="font-size:15px">${body}</p>` +
            `<p style="color:#6b7280;font-size:12px;margin-top:12px">CGuardPro · ${new Date().toLocaleString('es')}</p>`;
          await sendMail({ to: emails, subject: `${title}${route}`, html, text: body });
        }
      } catch (e: any) {
        console.warn('[ronda] email notify skipped/failed:', e?.message || e);
      }
    }

    // Email the tenant's admins/supervisors on completion — gated by its OWN
    // opt-in toggle (emailOnComplete), independent of the in-app/push toggle.
    // mailService throws when no transport is configured, so this only sends when
    // email is actually set up.
    if (wantEmail) {
      try {
        const emails = await resolveTenantNotifyEmails(db, tenantId);
        if (emails.length) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { sendMail } = require('./mailService');
          const html =
            `<p style="font-size:15px">${body}</p>` +
            `<p style="color:#6b7280;font-size:12px;margin-top:12px">CGuardPro · ${new Date().toLocaleString('es')}</p>`;
          await sendMail({ to: emails, subject: `${title}${route}`, html, text: body });
        }
      } catch (e: any) {
        console.warn('[ronda] email notify skipped/failed:', e?.message || e);
      }
    }

    if (wantClient && postSiteId) {
      // Notify the native CLIENT app (mi seguridad) for BOTH start and complete.
      // clientNotifyService resolves the client's user(s) and delivers via the
      // native channels: FCM push (pushToUser) + a platform_event scoped to that
      // client user (so the client app's websocket/in-app feed gets it too).
      try {
        const { notifyClient } = require('./clientNotifyService');
        await notifyClient(db, tenantId, { postSiteId }, {
          eventType: event === 'start' ? 'patrol.started' : 'patrol.completed',
          title,
          body: body.slice(0, 200),
          data: { type: `patrol_${event}`, routeName: routeName || '' },
          sourceEntityType: 'siteTour',
          sourceEntityId: String(postSiteId),
        });
      } catch (e: any) {
        console.warn('[ronda] client app notify failed:', e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[ronda] notifyPatrol failed:', e?.message || e);
  }
}
