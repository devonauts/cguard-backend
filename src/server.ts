require('dotenv').config()
// Backwards-compatible env var mappings for SendGrid and mail defaults
// Some deploys set SENDGRID_API_KEY / MAIL_DEFAULT_SENDER; older code expects SENDGRID_KEY and SENDGRID_EMAIL_FROM
if (process.env.SENDGRID_API_KEY && !process.env.SENDGRID_KEY) {
  process.env.SENDGRID_KEY = process.env.SENDGRID_API_KEY;
}
if (process.env.MAIL_DEFAULT_SENDER && !process.env.SENDGRID_EMAIL_FROM) {
  process.env.SENDGRID_EMAIL_FROM = process.env.MAIL_DEFAULT_SENDER;
}
if (process.env.MAIL_DEFAULT_SENDER_NAME && !process.env.SENDGRID_EMAIL_FROM_NAME) {
  process.env.SENDGRID_EMAIL_FROM_NAME = process.env.MAIL_DEFAULT_SENDER_NAME;
}
import http from 'http'
import api from './api'
import { databaseInit } from './database/databaseConnection';
import TenantInvitationRepository from './database/repositories/tenantInvitationRepository';
import { ensurePlatformEventsTable, cleanupOldPlatformEvents, storePlatformEvent } from './lib/platformEventStore';
import { initRealtime } from './lib/realtime';
import { syncGuardDutyStatus } from './services/dutySync';
import { verifySchemaConsistency } from './database/migrations/verify-schema';
import { setInterval as nodeSetInterval } from 'timers';

// const PORT = process.env.PORT || 8080
const PORT = Number(process.env.PORT) || 3001

const tenantMode = process.env.TENANT_MODE || 'multi';
console.log(`TENANT_MODE: ${tenantMode}`);

// Robust start: if port is in use, try the next ports up to a limit
function startServer(port: number, attemptsLeft = 5) {
  // Wrap the Express app in an explicit HTTP server so socket.io can share the
  // same port/listener.
  const server = http.createServer(api);

  // Attach the websocket (socket.io) transport for realtime notifications.
  initRealtime(server).catch((err) => {
    console.error('[realtime] init failed:', err?.message || err);
  });

  server.listen(port, () => {
    console.log(`Listening on port ${port}`);
    // Signal PM2 that the app is ready (for wait_ready / graceful reload)
    if (typeof process.send === 'function') {
      process.send('ready');
    }
  });

  server.on('error', (err: any) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use.`);
      if (attemptsLeft > 0) {
        const nextPort = port + 1;
        console.log(`Attempting to listen on port ${nextPort} (attempts left: ${attemptsLeft - 1})`);
        // small delay before retrying
        setTimeout(() => startServer(nextPort, attemptsLeft - 1), 250);
      } else {
        console.error('All retry attempts failed. Either free the port or set PORT env var to a different value.');
        console.error('On Windows, run: netstat -ano | findstr :<PORT>  then taskkill /PID <PID> /F');
        process.exit(1);
      }
    } else {
      console.error('Server error during startup:', err);
      process.exit(1);
    }
  });

  return server;
}

async function boot() {
  // Optional startup schema guard: set SCHEMA_VERIFY_ON_BOOT=true to fail fast
  // when DB schema is out of sync with Sequelize models.
  if (String(process.env.SCHEMA_VERIFY_ON_BOOT || '').toLowerCase() === 'true') {
    await verifySchemaConsistency();
    console.log('[SchemaGuard] Schema verification passed');
  }

  startServer(PORT, 5);
}

boot().catch((err) => {
  console.error('[Startup] Boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Periodic cleanup: remove expired tenant invitations every 3 hours
async function runExpiredInvitesCleanup() {
  try {
    const database = await databaseInit();
    const deleted = await TenantInvitationRepository.deleteExpired({
      database,
      language: '',
      currentUser: undefined,
      currentTenant: undefined
    });
    if (deleted && deleted > 0) {
      console.log(`Expired tenant invitations cleanup: deleted ${deleted} rows`);
    }
  } catch (err) {
    console.error('Error cleaning expired tenant invitations:', err);
  }
}

// Run once at startup
runExpiredInvitesCleanup();

// Initialize platform_events table and schedule cleanup
async function initPlatformEvents() {
  try {
    const database = await databaseInit();
    await ensurePlatformEventsTable(database);
    console.log('[PlatformEvents] Table ready');
  } catch (err) {
    console.error('[PlatformEvents] Table init failed:', (err as any)?.message || err);
  }
}

async function runPlatformEventsCleanup() {
  try {
    const database = await databaseInit();
    await cleanupOldPlatformEvents(database);
  } catch (err) {
    console.error('[PlatformEvents] Cleanup failed:', (err as any)?.message || err);
  }
}

initPlatformEvents();

// Schedule periodic cleanup every 3 hours
nodeSetInterval(() => {
  runExpiredInvitesCleanup();
  runPlatformEventsCleanup();
}, 3 * 60 * 60 * 1000);

// Sync guard duty status every 5 minutes based on active shifts
nodeSetInterval(() => {
  syncGuardDutyStatus();
}, 5 * 60 * 1000);

// Run once on startup after a short delay
setTimeout(() => syncGuardDutyStatus(), 10000);

/**
 * Consigna scheduler — every minute, find active station consignas whose
 * notify-moment (time − notifyMinutesBefore) has just arrived for today and that
 * haven't been pushed yet for this occurrence, then push to the station's guards
 * and record a platform event. `lastNotifiedAt` dedupes per occurrence.
 */
async function runConsignaScheduler() {
  try {
    const database = await databaseInit();
    const { isDueOn, dueAt } = require('./services/consignaRecurrence');
    const { sendToTokens } = require('./services/pushService');
    const { Op } = require('sequelize');
    const now = new Date();

    const orders = await database.stationOrder.findAll({
      where: { active: true, notifyEnabled: true, deletedAt: null },
    });
    const tzCache: Record<string, string> = {};
    const tzFor = async (tenantId: string) => {
      if (tzCache[tenantId]) return tzCache[tenantId];
      const tn = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
      return (tzCache[tenantId] = tn?.timezone || 'UTC');
    };
    for (const o of orders) {
      const order = o.get({ plain: true });
      const tz = await tzFor(order.tenantId);
      if (!isDueOn(order, now, tz)) continue;
      const due = dueAt(order, now, tz);
      const notifyMoment = new Date(due.getTime() - (Number(order.notifyMinutesBefore) || 0) * 60000);
      // fire only inside a 15-min window after the notify moment
      if (now < notifyMoment || now.getTime() - notifyMoment.getTime() > 15 * 60000) continue;
      // already pushed for this occurrence?
      if (order.lastNotifiedAt && new Date(order.lastNotifiedAt) >= notifyMoment) continue;

      // resolve the station's assigned guards → their device tokens
      const station = await database.station.findOne({
        where: { id: order.stationId },
        attributes: ['id', 'stationName'],
        include: [{ model: database.user, as: 'assignedGuards', attributes: ['id'], through: { attributes: [] } }],
      });
      const userIds = (station?.assignedGuards || []).map((u: any) => u.id);
      let tokens: string[] = [];
      if (userIds.length) {
        const devices = await database.deviceIdInformation.findAll({ where: { tenantId: order.tenantId, createdById: { [Op.in]: userIds } } });
        tokens = devices.map((d: any) => d.deviceId).filter(Boolean);
      }
      const title = `Consigna: ${order.title}`;
      const body = order.time ? `Programada para las ${order.time}${station?.stationName ? ' · ' + station.stationName : ''}` : (station?.stationName || '');
      if (tokens.length) {
        await sendToTokens(tokens, { title, body, data: { type: 'consigna.due', orderId: order.id, stationId: order.stationId } });
      }
      try {
        await storePlatformEvent(database, {
          tenantId: order.tenantId, eventType: 'consigna.due', title, body,
          payload: { orderId: order.id, stationId: order.stationId, time: order.time },
          targetRoles: 'securityGuard,securitySupervisor,admin',
          sourceEntityType: 'stationOrder', sourceEntityId: order.id,
        });
      } catch { /* ignore */ }
      await o.update({ lastNotifiedAt: now });
      console.log(`[Consigna] notified "${order.title}" -> ${tokens.length} device(s)`);
    }
  } catch (err) {
    console.error('[Consigna] scheduler error:', (err as any)?.message || err);
  }
}

// Check due consignas every minute
nodeSetInterval(() => { runConsignaScheduler(); }, 60 * 1000);
setTimeout(() => runConsignaScheduler(), 20000);

/**
 * Trial scheduler — sends reminder emails as a tenant's 14-day trial winds down
 * (stages at 7 / 3 / 1 days left and on expiry) and flips expired trials to
 * `trial_expired`. `trialReminderStage` dedupes; the conditional UPDATE makes it
 * safe across the PM2 cluster (only one worker wins each stage).
 */
async function runTrialScheduler() {
  try {
    const database = await databaseInit();
    const { Op } = require('sequelize');
    const { sendMail } = require('./services/mailService');
    const { tenantSubdomain } = require('./services/tenantSubdomain');
    const { trialInfo } = require('./services/subscriptionService');

    const tenants = await database.tenant.findAll({ where: { billingStatus: 'trialing' } });

    for (const tenant of tenants) {
      const info = trialInfo(tenant.get ? tenant.get({ plain: true }) : tenant);
      const daysLeft = info.daysLeft;
      let stage = 0;
      if (info.expired) stage = 4;
      else if (daysLeft <= 1) stage = 3;
      else if (daysLeft <= 3) stage = 2;
      else if (daysLeft <= 7) stage = 1;
      if (stage === 0) continue;

      // Cluster-safe claim: only the worker that raises the stage proceeds.
      const [claimed] = await database.tenant.update(
        { trialReminderStage: stage },
        { where: { id: tenant.id, trialReminderStage: { [Op.lt]: stage } } },
      );
      if (!claimed) continue;

      if (stage >= 4) {
        await database.tenant.update(
          { billingStatus: 'trial_expired' },
          { where: { id: tenant.id, billingStatus: 'trialing' } },
        );
      }

      // Resolve the owner/admin recipient.
      let to: string | null = null;
      try {
        const admins = await database.tenantUser.findAll({
          where: { tenantId: tenant.id },
          include: [{ model: database.user, as: 'user', attributes: ['email'] }],
        });
        for (const tu of admins) {
          const roles = Array.isArray(tu.roles) ? tu.roles : String(tu.roles || '').split(',');
          if (roles.includes('admin') && tu.user?.email) { to = tu.user.email; break; }
        }
        if (!to) to = tenant.email || null;
      } catch { /* ignore */ }
      if (!to) continue;

      const link = `${tenantSubdomain.frontendUrl(tenant)}/setting/billing`;
      const name = tenant.name || 'tu organización';
      const headline =
        stage >= 4 ? `Tu prueba gratuita de ${name} ha terminado`
        : daysLeft <= 1 ? `Tu prueba gratuita termina mañana`
        : `Tu prueba gratuita termina en ${daysLeft} días`;
      const lead =
        stage >= 4
          ? 'Para seguir usando CGuardPro, activa tu suscripción. Es $5 por usuario al mes, más una implementación única de $250.'
          : `Te quedan ${daysLeft} día(s) de prueba. Activa tu suscripción para no perder el acceso: $5 por usuario al mes, más una implementación única de $250.`;

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;background:#f0f4f8;padding:24px">
          <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(16,24,40,.08)">
            <div style="background:#0f172a;padding:24px 32px;text-align:center;color:#fff;font-size:20px;font-weight:700">CGuardPro</div>
            <div style="padding:32px">
              <h1 style="font-size:22px;color:#111827;margin:0 0 12px">${headline}</h1>
              <p style="color:#374151;line-height:1.7;margin:0 0 20px">${lead}</p>
              <div style="text-align:center;margin:24px 0">
                <a href="${link}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700">Activar suscripción</a>
              </div>
              <p style="font-size:12px;color:#9ca3af">Si ya activaste tu suscripción, ignora este correo.</p>
            </div>
          </div>
        </div>`;

      try {
        await sendMail({ to, subject: `[CGuardPro] ${headline}`, html });
        console.log(`[Trial] reminder stage ${stage} sent to ${to} (${name})`);
      } catch (e) {
        console.warn('[Trial] reminder send failed:', (e as any)?.message || e);
      }
    }
  } catch (err) {
    console.error('[Trial] scheduler error:', (err as any)?.message || err);
  }
}

// Check trials a few times a day.
nodeSetInterval(() => { runTrialScheduler(); }, 6 * 60 * 60 * 1000);
setTimeout(() => runTrialScheduler(), 30000);

/**
 * Seat reconciliation — once a day, push each active tenant's current
 * billable-user count to its Stripe subscription so the monthly invoice
 * reflects added/removed users (Stripe prorates the difference).
 */
async function runSeatReconcile() {
  try {
    const database = await databaseInit();
    const { reconcileAllSubscriptions } = require('./services/subscriptionSync');
    const r = await reconcileAllSubscriptions(database);
    if (r && r.updated) {
      console.log(`[seatSync] reconciled ${r.updated}/${r.tenants} subscription(s)`);
    }
  } catch (err) {
    console.error('[seatSync] scheduler error:', (err as any)?.message || err);
  }
}

// Reconcile seats once a day.
nodeSetInterval(() => { runSeatReconcile(); }, 24 * 60 * 60 * 1000);
setTimeout(() => runSeatReconcile(), 60000);

/**
 * Attendance detection (Nómina) — every 5 minutes, scan recently-started shifts
 * and flag late / no-call-no-show / missed-clock-out exceptions by comparing the
 * scheduled `shift` against the guard's `guardShift` punch (linked via shiftId).
 * Idempotent: one open exception per (shiftId,type); dispatches notifications.
 */
async function runAttendanceDetectionScheduler() {
  try {
    const database = await databaseInit();
    const { Op } = require('sequelize');
    const { detectForShift, EXCEPTION_EVENT } = require('./lib/attendanceRules');
    const { getNominaSettings } = require('./lib/nominaSettings');
    const { dispatch } = require('./lib/notificationDispatcher');
    const now = new Date();

    // Shifts that have started within the last 24h (window where late/no-show/
    // missed-clockout become detectable). Cap to keep each tick bounded.
    const shifts = await database.shift.findAll({
      where: {
        startTime: { [Op.lte]: now, [Op.gte]: new Date(now.getTime() - 24 * 3600 * 1000) },
      },
      limit: 2000,
    });

    const settingsCache: Record<string, any> = {};
    const settingsFor = async (tenantId: string) =>
      settingsCache[tenantId] || (settingsCache[tenantId] = await getNominaSettings(database, tenantId));

    let flagged = 0;
    for (const sh of shifts) {
      const shift = sh.get({ plain: true });
      const settings = await settingsFor(shift.tenantId);
      if (!settings.general.timeClockEnabled) continue;

      const punch = await database.guardShift.findOne({
        where: { shiftId: shift.id, tenantId: shift.tenantId },
        attributes: ['id', 'punchOutTime'],
      });
      const spec = detectForShift(
        {
          now,
          shiftStart: new Date(shift.startTime),
          shiftEnd: new Date(shift.endTime),
          hasClockIn: !!punch,
          hasClockOut: !!(punch && punch.punchOutTime),
        },
        settings,
      );
      if (!spec) continue;

      const existing = await database.attendanceException.findOne({
        where: { tenantId: shift.tenantId, shiftId: shift.id, type: spec.type, status: 'open' },
        attributes: ['id'],
      });
      if (existing) continue;

      const sg = await database.securityGuard.findOne({
        where: { guardId: shift.guardId, tenantId: shift.tenantId },
        attributes: ['id', 'fullName'],
      });
      const station = await database.station.findByPk(shift.stationId, { attributes: ['stationName'] });

      const row = await database.attendanceException.create({
        type: spec.type,
        severity: spec.severity,
        status: 'open',
        reason: spec.reason || null,
        meta: spec.meta ? JSON.stringify(spec.meta) : null,
        detectedAt: now,
        guardShiftId: punch ? punch.id : null,
        shiftId: shift.id,
        guardId: sg?.id || null,
        stationId: shift.stationId || null,
        postSiteId: shift.postSiteId || null,
        tenantId: shift.tenantId,
      });
      flagged++;

      const eventType = EXCEPTION_EVENT[spec.type];
      if (eventType) {
        try {
          await dispatch(eventType, {
            guardName: sg?.fullName || 'Guardia',
            stationName: station?.stationName || null,
            reason: spec.reason || '',
            type: spec.type,
          }, {
            database,
            tenantId: shift.tenantId,
            sourceEntityType: 'attendanceException',
            sourceEntityId: row.id,
            extraEmails: settings.notifications?.customEmails || [],
          });
        } catch { /* best-effort */ }
      }
    }
    if (flagged) console.log(`[attendance] detection flagged ${flagged} exception(s)`);
  } catch (err) {
    console.error('[attendance] detection scheduler error:', (err as any)?.message || err);
  }
}

// Detect attendance exceptions every 5 minutes.
nodeSetInterval(() => { runAttendanceDetectionScheduler(); }, 5 * 60 * 1000);
setTimeout(() => runAttendanceDetectionScheduler(), 45000);

