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
import api from './api'
import { databaseInit } from './database/databaseConnection';
import TenantInvitationRepository from './database/repositories/tenantInvitationRepository';
import { ensurePlatformEventsTable, cleanupOldPlatformEvents, storePlatformEvent } from './lib/platformEventStore';
import { syncGuardDutyStatus } from './services/dutySync';
import { verifySchemaConsistency } from './database/migrations/verify-schema';
import { setInterval as nodeSetInterval } from 'timers';

// const PORT = process.env.PORT || 8080
const PORT = Number(process.env.PORT) || 3001

const tenantMode = process.env.TENANT_MODE || 'multi';
console.log(`TENANT_MODE: ${tenantMode}`);

// Robust start: if port is in use, try the next ports up to a limit
function startServer(port: number, attemptsLeft = 5) {
  const server = api.listen(port, () => {
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
    for (const o of orders) {
      const order = o.get({ plain: true });
      if (!isDueOn(order, now)) continue;
      const due = dueAt(order, now);
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

