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
import { ensurePlatformEventsTable, ensurePlatformEventDismissalsTable, cleanupOldPlatformEvents, storePlatformEvent } from './lib/platformEventStore';
import { initRealtime } from './lib/realtime';
import { syncGuardDutyStatus } from './services/dutySync';
import { runJob } from './lib/jobsMonitor';
import { startWorkerMetrics } from './lib/workerMetrics';
import { verifySchemaConsistency } from './database/migrations/verify-schema';
import { setInterval as nodeRealSetInterval } from 'timers';

// ── Cluster-safe scheduling (single-box leader election) ─────────────────────
// PM2 runs this server file in EVERY cluster instance, so any setInterval-based
// scheduler fired once PER INSTANCE — doubling every digest email, shift reminder,
// radio check, forced clock-out, etc. We must run scheduled jobs on ONE instance.
// NOTE: we deliberately do NOT trust PM2's NODE_APP_INSTANCE — on this box it is 2/3
// (global, not 0-based per app), so a "=== 0" leader test would elect NO leader.
// Instead, a heartbeat LOCK FILE on the shared box decides the leader: whichever
// instance holds a fresh lock is leader; if it dies, another claims it after the TTL.
const _leaderFs = require('fs');
const _leaderPath = require('path').join(process.cwd(), '.scheduler-leader.lock');
const LEADER_TTL_MS = 30_000;
let _amLeader = false;
function _heartbeatLeader() {
  const now = Date.now();
  try {
    let owner: any = null;
    try { owner = JSON.parse(_leaderFs.readFileSync(_leaderPath, 'utf8')); } catch { /* no/garbage lock */ }
    const fresh = owner && typeof owner.ts === 'number' && (now - owner.ts) < LEADER_TTL_MS;
    if (owner && owner.pid === process.pid) {
      _leaderFs.writeFileSync(_leaderPath, JSON.stringify({ pid: process.pid, ts: now })); // renew
      _amLeader = true;
    } else if (!fresh) {
      _leaderFs.writeFileSync(_leaderPath, JSON.stringify({ pid: process.pid, ts: now })); // claim
      try { _amLeader = JSON.parse(_leaderFs.readFileSync(_leaderPath, 'utf8')).pid === process.pid; } catch { _amLeader = false; }
    } else {
      _amLeader = false; // someone else holds a fresh lock
    }
  } catch { /* keep prior state on FS error */ }
}
_heartbeatLeader();
nodeRealSetInterval(_heartbeatLeader, 10_000); // contend/renew every 10s (runs in all instances)
const isSchedulerLeader = () => _amLeader;

// Drop-in wrappers used by every scheduler below. Leadership is checked at FIRE time
// (it can change if the leader dies), so a non-leader instance simply skips the tick.
const nodeSetInterval: typeof nodeRealSetInterval = ((fn: any, ms?: any) =>
  nodeRealSetInterval(() => { if (isSchedulerLeader()) (fn as any)(); }, ms)) as any;
// Same gate for the one-shot "kick the scheduler shortly after boot" timers — they
// ran on EVERY reload in EVERY instance, re-firing reminders/checks each deploy.
const leaderTimeout = (fn: () => void, ms: number) => { setTimeout(() => { if (isSchedulerLeader()) fn(); }, ms); };

// Process-level safety net. Without these, a single unhandled promise rejection or
// uncaught exception anywhere (a route, a scheduler, a stray await) crashes the
// worker — Node exits by default — and every in-flight request, e.g. the radio
// console poll, gets a 500 with no CORS header while pm2 restarts it. Log loudly so
// the real cause stays fixable, but keep the worker alive instead of crash-looping.
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection]', (reason && reason.stack) ? reason.stack : reason);
  try {
    require('./lib/errorTracker').capture(
      reason instanceof Error ? reason : new Error(String(reason)),
      { source: 'unhandledRejection', statusCode: 0 },
    );
  } catch { /* best-effort */ }
});
process.on('uncaughtException', (err: any) => {
  console.error('[uncaughtException]', (err && err.stack) ? err.stack : err);
  try {
    require('./lib/errorTracker').capture(err, { source: 'uncaughtException', statusCode: 0 });
  } catch { /* best-effort */ }
  // After an uncaught exception the process is in an undefined state — persist the
  // error (above), then exit so PM2 restarts a clean worker instead of limping on
  // with corrupt state. The 1s delay lets the error write + logs flush.
  setTimeout(() => process.exit(1), 1000);
});

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

/**
 * Fail-fast secret assertion. In production a missing or known-default critical
 * secret is a security incident waiting to happen (forged tokens, cross-tenant
 * decryption), so we refuse to start rather than boot in a compromised state.
 * Non-production is only warned, so local/dev still runs.
 */
function assertCriticalSecrets() {
  const prod = process.env.NODE_ENV === 'production';
  const problems: string[] = [];

  const jwt = process.env.AUTH_JWT_SECRET || '';
  const WEAK = new Set([
    '', 'secret', 'changeme', 'default', 'jwt-secret', 'superadmin-jwt-secret',
    'default-superadmin-key', 'cguard-insecure-fallback-key',
  ]);
  if (WEAK.has(jwt) || jwt.length < 16) {
    problems.push('AUTH_JWT_SECRET is missing, too short, or a known-default value');
  }
  // secretBox derives its key from SETTINGS_ENC_KEY, else AUTH_JWT_SECRET, else
  // an insecure literal — assert at least one strong source exists.
  const encMaterial = process.env.SETTINGS_ENC_KEY || process.env.AUTH_JWT_SECRET || '';
  if (WEAK.has(encMaterial) || encMaterial.length < 16) {
    problems.push('No strong SETTINGS_ENC_KEY / AUTH_JWT_SECRET for secretBox encryption');
  }
  // Database credentials must be present.
  for (const k of ['DATABASE_DATABASE', 'DATABASE_USERNAME', 'DATABASE_PASSWORD']) {
    if (!process.env[k]) problems.push(`${k} is not set`);
  }

  if (problems.length) {
    const msg = '[Startup] CRITICAL SECRET CHECK FAILED:\n  - ' + problems.join('\n  - ');
    if (prod) {
      console.error(msg + '\nRefusing to start in production with insecure configuration.');
      process.exit(1);
    } else {
      console.warn(msg + '\n(non-production: continuing, but fix before deploying)');
    }
  } else {
    console.log('[Startup] Critical secret check passed.');
  }
}

async function boot() {
  // Refuse to boot production with missing/default critical secrets.
  assertCriticalSecrets();

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
    await ensurePlatformEventDismissalsTable(database);
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

// Keep the append-only GPS breadcrumb table (locationPings) bounded — delete
// trails older than LOCATION_TRAIL_RETENTION_DAYS (default 30). Leader-only via
// runJob; best-effort.
async function runLocationTrailCleanup() {
  try {
    const database = await databaseInit();
    if (!database.locationPing) return;
    const days = Number(process.env.LOCATION_TRAIL_RETENTION_DAYS) || 30;
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const { Op } = require('sequelize');
    const deleted = await database.locationPing.destroy({ where: { recordedAt: { [Op.lt]: cutoff } } });
    if (deleted) console.log(`[LocationTrail] Purged ${deleted} pings older than ${days}d`);
  } catch (err) {
    console.error('[LocationTrail] Cleanup failed:', (err as any)?.message || err);
  }
}

// C6: seed built-in roles as rows in the `roles` table on startup if missing.
// Additive + best-effort; the FK-backed tenantUserRoles join relies on these.
async function initBuiltInRoles() {
  try {
    const database = await databaseInit();
    const { ensureBuiltInRoles } = require('./services/roleSync');
    await ensureBuiltInRoles(database);
    console.log('[roleSync] Built-in roles ensured');
  } catch (err) {
    console.error('[roleSync] ensureBuiltInRoles failed:', (err as any)?.message || err);
  }
}

initBuiltInRoles();

// Publish this worker's resource metrics for the per-worker observability view.
startWorkerMetrics();

// Start the BullMQ consumer (each PM2 worker runs one; BullMQ shares the load).
// Load the handler-registering services first so their handlers are known.
try {
  require('./services/mailService');
  require('./lib/queue').startQueueWorker();
} catch (e: any) {
  console.error('[queue] init failed:', e?.message || e);
}

// Schedule periodic cleanup every 3 hours (wrapped so they show in the Jobs panel)
nodeSetInterval(() => {
  runJob("ExpiredInvitesCleanup", runExpiredInvitesCleanup);
  runJob("PlatformEventsCleanup", runPlatformEventsCleanup);
  runJob("LocationTrailCleanup", runLocationTrailCleanup);
}, 3 * 60 * 60 * 1000);

// Observability: snapshot system/pool/slow/error metrics every minute (leader
// only) into the time series, then evaluate thresholds and fire alerts. Turns
// every instantaneous metric into a trend + gives the platform a "tell me before
// users do" path (disk/RAM/heap/pool/error-spike/job-failure).
nodeSetInterval(() => {
  runJob("MetricsSnapshot", async () => {
    const metrics = await require('./lib/metricsHistory').captureSnapshot();
    const ae = require('./lib/alertEvaluator');
    await ae.evaluate(metrics);        // instantaneous threshold breaches
    await ae.evaluateTrends();         // slow-leak / RSS-creep detection
  });
}, 60 * 1000);

// Daily ops heartbeat digest (leader only): checks hourly, emails once/day at
// ALERT_DIGEST_HOUR so "all good" is something you receive, not something you
// check — and its absence flags an outage.
nodeSetInterval(() => { runJob("OpsDigest", () => require('./lib/opsDigest').sendDigestIfDue()); }, 60 * 60 * 1000);

// Automated DB backups (leader only): daily mysqldump → gzip → rotate → optional
// off-box S3. Plus a boot-time run if the newest backup is stale (>20h) so a
// long gap self-heals without waiting a full day.
nodeSetInterval(() => { runJob("DbBackup", () => require('./lib/dbBackup').runBackup()); }, 24 * 60 * 60 * 1000);
leaderTimeout(() => { runJob("DbBackup", () => require('./lib/dbBackup').runBackupIfStale()); }, 3 * 60 * 1000);

// Sync guard duty status every 5 minutes based on active shifts
nodeSetInterval(() => { runJob("DutySync", syncGuardDutyStatus); }, 5 * 60 * 1000);

// Guard inactivity alerts (Configuración Global de Vigilantes): on-duty guards
// whose device went silent past the tenant threshold → guard.inactive.
nodeSetInterval(() => {
  runJob("GuardInactivity", async () => {
    const database = await databaseInit();
    const { runGuardInactivitySweep } = require('./services/guardInactivityService');
    await runGuardInactivitySweep(database);
  });
}, 5 * 60 * 1000);

// Missed/overdue rondas (Configuración › Rondas › notificar perdidas/tarde).
nodeSetInterval(() => {
  runJob("RondaMissed", async () => {
    const database = await databaseInit();
    const { runRondaMissedSweep } = require('./services/rondaMissedService');
    await runRondaMissedSweep(database);
  });
}, 5 * 60 * 1000);

// Guard credential/license expiry (daily; weekly re-alert until renewed).
nodeSetInterval(() => {
  runJob("LicenseExpiry", async () => {
    const database = await databaseInit();
    const { runLicenseExpirySweep } = require('./services/licenseExpiryService');
    await runLicenseExpirySweep(database);
  });
}, 24 * 60 * 60 * 1000);
leaderTimeout(() => runJob("LicenseExpiry", async () => {
  const database = await databaseInit();
  const { runLicenseExpirySweep } = require('./services/licenseExpiryService');
  await runLicenseExpirySweep(database);
}), 90 * 1000);

// Run once on startup after a short delay. NOTE: boot kicks (here and below) go
// through runJob too, so its in-flight guard prevents a slow boot run from
// overlapping the first interval tick.
leaderTimeout(() => runJob("DutySync", syncGuardDutyStatus), 10000);

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

    // Lean load: only the columns the recurrence check + notification need
    // (drops description TEXT etc. — this scans ALL notify-enabled consignas
    // platform-wide every minute, so row width matters).
    const orders = await database.stationOrder.findAll({
      where: { active: true, notifyEnabled: true, deletedAt: null },
      attributes: [
        'id', 'tenantId', 'stationId', 'title', 'time', 'recurrence',
        'days', 'dayOfMonth', 'date', 'notifyMinutesBefore', 'lastNotifiedAt',
      ],
    });
    // One query for every involved tenant's timezone (was one query per tenant).
    const tzCache: Record<string, string> = {};
    if (orders.length) {
      const tenantIds = [...new Set(orders.map((o: any) => o.tenantId))];
      const tenants = await database.tenant.findAll({
        where: { id: { [Op.in]: tenantIds } },
        attributes: ['id', 'timezone'],
      });
      for (const t of tenants) tzCache[t.id] = t.timezone || 'UTC';
    }
    for (const o of orders) {
      const order = o.get({ plain: true });
      const tz = tzCache[order.tenantId] || 'UTC';
      if (!isDueOn(order, now, tz)) continue;
      const due = dueAt(order, now, tz);
      const notifyMoment = new Date(due.getTime() - (Number(order.notifyMinutesBefore) || 0) * 60000);
      // fire only inside a 15-min window after the notify moment
      if (now < notifyMoment || now.getTime() - notifyMoment.getTime() > 15 * 60000) continue;
      // already pushed for this occurrence? (cheap pre-check on the loaded row)
      if (order.lastNotifiedAt && new Date(order.lastNotifiedAt) >= notifyMoment) continue;
      // Atomic per-occurrence claim (conditional UPDATE — same pattern as the
      // trial/radio-check schedulers): only the worker whose UPDATE matches
      // proceeds, so an overlapping tick or a leader hand-off can't double-send.
      const [claimed] = await database.stationOrder.update(
        { lastNotifiedAt: now },
        {
          where: {
            id: order.id,
            [Op.or]: [{ lastNotifiedAt: null }, { lastNotifiedAt: { [Op.lt]: notifyMoment } }],
          },
        },
      );
      if (!claimed) continue;

      // resolve the station's assigned guards (guardAssignment — single source
      // of truth; the legacy pivot routed these pushes to stale guards) → tokens
      const station = await database.station.findOne({
        where: { id: order.stationId },
        attributes: ['id', 'stationName'],
      });
      const { guardUserIdsForStations } = require('./services/assignedStationsService');
      const userIds: string[] = await guardUserIdsForStations(database, order.tenantId, [String(order.stationId)]);
      let tokens: string[] = [];
      if (userIds.length) {
        const devices = await database.deviceIdInformation.findAll({ where: { tenantId: order.tenantId, createdById: { [Op.in]: userIds } }, attributes: ['deviceId'] });
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
      console.log(`[Consigna] notified "${order.title}" -> ${tokens.length} device(s)`);
    }
  } catch (err) {
    console.error('[Consigna] scheduler error:', (err as any)?.message || err);
  }
}

// Check due consignas every minute
nodeSetInterval(() => { runJob("Consigna", runConsignaScheduler); }, 60 * 1000);
leaderTimeout(() => runJob("Consigna", runConsignaScheduler), 20000);

/**
 * Radio check (pase de novedades) scheduler. Two jobs each minute:
 *   1) Advance EVERY running session (manual or auto) — times out the current
 *      station and calls the next one. Idempotent conditional UPDATEs make this
 *      safe across the PM2 cluster.
 *   2) For each enabled tenant inside its active hours, auto-start a roll call
 *      when one is due. The atomic conditional UPDATE on `lastAutoRunAt` (the
 *      trial-scheduler pattern) guarantees exactly one worker fires it.
 */
async function runRadioCheckScheduler() {
  try {
    const database = await databaseInit();
    const { Op } = require('sequelize');
    const radioSvc = require('./services/radioCheckService');
    const now = new Date();

    const tzCache: Record<string, string> = {};
    const tzFor = async (tenantId: string) => {
      if (tzCache[tenantId]) return tzCache[tenantId];
      const tn = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
      return (tzCache[tenantId] = tn?.timezone || 'UTC');
    };
    const inActiveHours = (tz: string, start?: string | null, end?: string | null) => {
      if (!start || !end) return true;
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end; // overnight window
    };

    // 1) Advance running sessions (timeouts move the roll call station-by-station).
    const running = await database.radioCheckSession.findAll({ where: { status: 'running', deletedAt: null }, attributes: ['id', 'tenantId'] });
    for (const s of running) {
      await radioSvc.advanceSession(database, s.tenantId, s.id).catch(() => {});
    }

    // 1b) Self-heal orphaned entries: a session that stopped RUNNING (cancelled/
    //     completed) must never leave a station stuck at 'notified' — the console
    //     would render it as a perpetual timeout. 'notified' entries are inherently
    //     few (one active per running session + any orphans), so key off them and
    //     drop those whose session is no longer running. Backstop for any path
    //     that didn't clean up its own entries.
    const notifiedEntries = await database.radioCheckEntry.findAll({
      where: { status: 'notified', deletedAt: null }, attributes: ['id', 'sessionId'],
    });
    if (notifiedEntries.length) {
      const sessIds = [...new Set(notifiedEntries.map((e: any) => e.sessionId))];
      const liveSess = new Set(
        (await database.radioCheckSession.findAll({
          where: { id: { [Op.in]: sessIds }, status: 'running', deletedAt: null }, attributes: ['id'],
        })).map((r: any) => r.id),
      );
      const orphanIds = notifiedEntries.filter((e: any) => !liveSess.has(e.sessionId)).map((e: any) => e.id);
      if (orphanIds.length) {
        await database.radioCheckEntry.update(
          { status: 'no_response' }, { where: { id: { [Op.in]: orphanIds } } },
        ).catch(() => {});
      }
    }

    // 2) Auto-start due roll calls for enabled tenants (cluster-safe atomic claim).
    const settingsRows = await database.radioCheckSettings.findAll({ where: { enabled: true, deletedAt: null } });
    for (const st of settingsRows) {
      const tz = await tzFor(st.tenantId);
      if (!inActiveHours(tz, st.activeHoursStart, st.activeHoursEnd)) continue;
      const threshold = new Date(now.getTime() - (st.intervalMinutes || 35) * 60000);
      const [claimed] = await database.radioCheckSettings.update(
        { lastAutoRunAt: now },
        { where: { tenantId: st.tenantId, [Op.or]: [{ lastAutoRunAt: null }, { lastAutoRunAt: { [Op.lte]: threshold } }] } },
      );
      if (!claimed) continue;
      // Don't stack roll calls — skip if one is already running for this tenant.
      const active = await database.radioCheckSession.findOne({ where: { tenantId: st.tenantId, status: 'running', deletedAt: null }, attributes: ['id'] });
      if (active) continue;
      await radioSvc.startSession(database, st.tenantId, { mode: 'auto', scope: 'all' })
        .then(() => console.log(`[RadioCheck] auto roll call started for tenant ${st.tenantId}`))
        .catch((e: any) => console.warn('[RadioCheck] auto start failed:', e?.message || e));
    }
  } catch (err) {
    console.error('[RadioCheck] scheduler error:', (err as any)?.message || err);
  }
}

nodeSetInterval(() => { runJob("RadioCheck", runRadioCheckScheduler); }, 60 * 1000);
leaderTimeout(() => runJob("RadioCheck", runRadioCheckScheduler), 35000);

/**
 * Forced clock-out — auto-closes shifts whose scheduled end passed (+grace) while
 * still clocked in, flags them as "salida forzada" (no novedades / no manual
 * close), applies a light performance penalty and notifies guard + admins.
 * Cluster-safe via a per-row atomic claim inside the service.
 */
async function runForcedClockOutScheduler() {
  try {
    const database = await databaseInit();
    const { runForcedShiftEndClockOut } = require('./services/forcedClockOutService');
    await runForcedShiftEndClockOut(database);
  } catch (err) {
    console.error('[forcedClockOut] scheduler error:', (err as any)?.message || err);
  }
}

nodeSetInterval(() => { runJob("ForcedClockOut", runForcedClockOutScheduler); }, 60 * 1000);
leaderTimeout(() => runJob("ForcedClockOut", runForcedClockOutScheduler), 45000);

// Supervisor forced clock-out — same idea over supervisorShift (never touches
// guardShift). Force-closes a supervisor punch left open past their turno end.
async function runSupervisorForcedClockOutScheduler() {
  try {
    const database = await databaseInit();
    const { runSupervisorForcedClockOut } = require('./services/supervisorForcedClockOutService');
    await runSupervisorForcedClockOut(database);
  } catch (err) {
    console.error('[supervisorForcedClockOut] scheduler error:', (err as any)?.message || err);
  }
}
nodeSetInterval(() => { runJob("SupervisorForcedClockOut", runSupervisorForcedClockOutScheduler); }, 60 * 1000);
leaderTimeout(() => runJob("SupervisorForcedClockOut", runSupervisorForcedClockOutScheduler), 50000);

/**
 * Shift reminders — push notifications to whoever is assigned a station turno
 * (guard/supervisor) at 2 days, 1 day, 12h, 1h and 10min before shift start, so
 * they don't miss going back to work after rest ("L") days. Cluster-safe via an
 * atomic per-(shift,offset) claim inside the service. Toggle SHIFT_REMINDERS_ENABLED.
 */
async function runShiftReminderScheduler() {
  try {
    const database = await databaseInit();
    const { runShiftReminders } = require('./services/shiftReminderService');
    await runShiftReminders(database);
  } catch (err) {
    console.error('[shiftReminders] scheduler error:', (err as any)?.message || err);
  }
}

nodeSetInterval(() => { runJob("ShiftReminders", runShiftReminderScheduler); }, 5 * 60 * 1000);
leaderTimeout(() => runJob("ShiftReminders", runShiftReminderScheduler), 60000);

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
nodeSetInterval(() => { runJob("TrialBilling", runTrialScheduler); }, 6 * 60 * 60 * 1000);
leaderTimeout(() => runJob("TrialBilling", runTrialScheduler), 30000);

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
nodeSetInterval(() => { runJob("SeatReconcile", runSeatReconcile); }, 24 * 60 * 60 * 1000);
leaderTimeout(() => runJob("SeatReconcile", runSeatReconcile), 60000);

/**
 * Recharge reconciliation — safety net for MISSED Stripe recharge webhooks:
 * sweeps the last 48h of checkout sessions for PAID wallet top-ups
 * (communications_recharge + the retired sms_recharge) and credits any that
 * never landed. Idempotent via creditWalletFromRecharge's reference=session.id
 * dedupe (taken under the wallet row lock), so re-scanning already-credited
 * sessions is a no-op. Never throws.
 */
async function runRechargeReconciliation() {
  try {
    const database = await databaseInit();
    const { reconcileRechargeSessions } = require('./services/communication/rechargeReconciliation');
    const r = await reconcileRechargeSessions(database);
    if (r && r.credited) {
      console.log(`[RechargeReconciliation] credited ${r.credited} missed recharge(s) (${r.matched} paid recharge session(s) scanned)`);
    }
  } catch (err) {
    console.error('[RechargeReconciliation] scheduler error:', (err as any)?.message || err);
  }
}

// Sweep every 6 hours + once shortly after boot (leader only).
nodeSetInterval(() => { runJob("RechargeReconciliation", runRechargeReconciliation); }, 6 * 60 * 60 * 1000);
leaderTimeout(() => runJob("RechargeReconciliation", runRechargeReconciliation), 2 * 60 * 1000);

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
    // missed-clockout become detectable). Paged deterministically (ORDER BY
    // startTime,id) so the whole window is evaluated — no silent truncation —
    // with a hard cap to keep each tick bounded (logged when it truncates).
    const PAGE_SIZE = 500;
    const MAX_SHIFTS_PER_TICK = 10000;

    const settingsCache: Record<string, any> = {};
    const settingsFor = async (tenantId: string) =>
      settingsCache[tenantId] || (settingsCache[tenantId] = await getNominaSettings(database, tenantId));

    let flagged = 0;
    let scanned = 0;
    for (;;) {
      const page = await database.shift.findAll({
        where: {
          startTime: { [Op.lte]: now, [Op.gte]: new Date(now.getTime() - 24 * 3600 * 1000) },
        },
        order: [['startTime', 'ASC'], ['id', 'ASC']],
        limit: PAGE_SIZE,
        offset: scanned,
      });
      if (!page.length) break;
      scanned += page.length;

      // Skip tenants with the time clock disabled (settings cached per tenant).
      const candidates: Array<{ shift: any; settings: any }> = [];
      for (const sh of page) {
        const shift = sh.get({ plain: true });
        const settings = await settingsFor(shift.tenantId);
        if (!settings.general.timeClockEnabled) continue;
        candidates.push({ shift, settings });
      }

      // Batch the per-shift punch lookup into ONE query for the page.
      const punchMap = new Map<string, any>();
      if (candidates.length) {
        const punches = await database.guardShift.findAll({
          where: { shiftId: { [Op.in]: candidates.map((c) => c.shift.id) } },
          attributes: ['id', 'punchOutTime', 'shiftId', 'tenantId'],
        });
        for (const p of punches) {
          const key = `${p.shiftId}|${p.tenantId}`;
          if (!punchMap.has(key)) punchMap.set(key, p);
        }
      }

      const hits: Array<{ shift: any; settings: any; punch: any; spec: any }> = [];
      for (const c of candidates) {
        const punch = punchMap.get(`${c.shift.id}|${c.shift.tenantId}`) || null;
        const spec = detectForShift(
          {
            now,
            shiftStart: new Date(c.shift.startTime),
            shiftEnd: new Date(c.shift.endTime),
            hasClockIn: !!punch,
            hasClockOut: !!(punch && punch.punchOutTime),
          },
          c.settings,
        );
        if (spec) hits.push({ ...c, punch, spec });
      }

      // Dedup (one open exception per shiftId+type): ONE query for the page.
      let fresh = hits;
      if (hits.length) {
        const existing = await database.attendanceException.findAll({
          where: { shiftId: { [Op.in]: hits.map((h) => h.shift.id) }, status: 'open' },
          attributes: ['shiftId', 'type', 'tenantId'],
        });
        const existingSet = new Set(
          existing.map((e: any) => `${e.tenantId}|${e.shiftId}|${e.type}`),
        );
        fresh = hits.filter(
          (h) => !existingSet.has(`${h.shift.tenantId}|${h.shift.id}|${h.spec.type}`),
        );
      }

      if (fresh.length) {
        // Batch the guard/station/user context lookups for the flagged shifts.
        const guardIds = [...new Set(fresh.map((h) => h.shift.guardId).filter(Boolean))];
        const sgMap = new Map<string, any>();
        const userMap = new Map<string, any>();
        if (guardIds.length) {
          const sgs = await database.securityGuard.findAll({
            where: {
              guardId: { [Op.in]: guardIds },
              tenantId: { [Op.in]: [...new Set(fresh.map((h) => h.shift.tenantId))] },
            },
            attributes: ['id', 'fullName', 'guardId', 'tenantId'],
          });
          for (const g of sgs) {
            const key = `${g.guardId}|${g.tenantId}`;
            if (!sgMap.has(key)) sgMap.set(key, g);
          }
          const users = await database.user.findAll({
            where: { id: { [Op.in]: guardIds } },
            attributes: ['id', 'email'],
          });
          for (const u of users) userMap.set(String(u.id), u);
        }
        const stationIds = [...new Set(fresh.map((h) => h.shift.stationId).filter(Boolean))];
        const stationMap = new Map<string, any>();
        if (stationIds.length) {
          const stations = await database.station.findAll({
            where: { id: { [Op.in]: stationIds } },
            attributes: ['id', 'stationName'],
          });
          for (const st of stations) stationMap.set(String(st.id), st);
        }

        for (const h of fresh) {
          const { shift, settings, punch, spec } = h;
          const sg = shift.guardId
            ? sgMap.get(`${shift.guardId}|${shift.tenantId}`) || null
            : null;
          const station = shift.stationId
            ? stationMap.get(String(shift.stationId)) || null
            : null;

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
                assignedPostSiteId:
                  settings.notifications?.assignedSupervisorsOnly && shift.postSiteId
                    ? shift.postSiteId
                    : undefined,
              });
            } catch { /* best-effort */ }
          }

          // Also notify the affected GUARD (in-app + email) with guard-facing copy
          // for lateness / no-show only. Deduped: this whole block runs once per
          // (shiftId,type) thanks to the open-exception gate above.
          if (spec.type === 'late_arrival' || spec.type === 'no_call_no_show') {
            try {
              // Resolve the guard's email: prefer the linked user's email, then the
              // securityGuard.email. If neither exists, skip silently.
              const guardUser = shift.guardId ? userMap.get(String(shift.guardId)) || null : null;
              const guardEmail: string | null = guardUser?.email || null;
              if (guardEmail) {
                const selfEvent =
                  spec.type === 'late_arrival' ? 'attendance.late_self' : 'attendance.no_show_self';
                await dispatch(selfEvent, {
                  stationName: station?.stationName || null,
                  minutesLate: spec.meta?.minutesLate ?? null,
                }, {
                  database,
                  tenantId: shift.tenantId,
                  sourceEntityType: 'attendanceException',
                  sourceEntityId: row.id,
                  recipientUserId: guardUser?.id || undefined,
                  recipientEmail: guardEmail,
                });
              }
            } catch { /* best-effort */ }
          }
        }
      }

      if (page.length < PAGE_SIZE) break; // window exhausted
      if (scanned >= MAX_SHIFTS_PER_TICK) {
        console.warn(
          `[attendance] detection tick truncated at ${MAX_SHIFTS_PER_TICK} shifts — more remain in the 24h window`,
        );
        break;
      }
    }
    if (flagged) console.log(`[attendance] detection flagged ${flagged} exception(s)`);
  } catch (err) {
    console.error('[attendance] detection scheduler error:', (err as any)?.message || err);
  }
}

// Detect attendance exceptions every 5 minutes.
nodeSetInterval(() => { runJob("AttendanceDetection", runAttendanceDetectionScheduler); }, 5 * 60 * 1000);
leaderTimeout(() => runJob("AttendanceDetection", runAttendanceDetectionScheduler), 45000);

/**
 * Repeated-lateness (Nómina) — hourly, flag guards with 3+ late punches in the
 * last 7 days and notify supervisors. Deduped to at most once / guard / 24h via
 * a marker exception (reason contains "3+ tardanzas").
 */
async function runRepeatedLatenessScheduler() {
  try {
    const database = await databaseInit();
    const { Op } = require('sequelize');
    const { dispatch } = require('./lib/notificationDispatcher');

    const [groups]: any = await database.sequelize.query(
      `SELECT tenantId, guardNameId, COUNT(*) c
       FROM guardShifts
       WHERE deletedAt IS NULL
         AND punchInTime > (NOW() - INTERVAL 7 DAY)
         AND (status = 'late' OR lateMinutes > 0)
       GROUP BY tenantId, guardNameId
       HAVING c >= 3
       LIMIT 1000`,
    );

    for (const g of groups || []) {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const dupe = await database.attendanceException.findOne({
        where: {
          tenantId: g.tenantId,
          guardId: g.guardNameId,
          type: 'late_arrival',
          reason: { [Op.like]: '%3+ tardanzas%' },
          detectedAt: { [Op.gte]: since },
        },
        attributes: ['id'],
      });
      if (dupe) continue;

      const sg = await database.securityGuard.findByPk(g.guardNameId, { attributes: ['id', 'fullName'] });
      const reason = `${g.c} tardanzas en 7 días (3+ tardanzas)`;
      const row = await database.attendanceException.create({
        type: 'late_arrival',
        severity: 'high',
        status: 'open',
        reason,
        meta: JSON.stringify({ repeated: true, count: g.c }),
        detectedAt: new Date(),
        guardId: g.guardNameId,
        tenantId: g.tenantId,
      });
      try {
        await dispatch('attendance.late', {
          guardName: sg?.fullName || 'Guardia',
          reason,
          type: 'late_arrival',
        }, { database, tenantId: g.tenantId, sourceEntityType: 'attendanceException', sourceEntityId: row.id });
      } catch { /* best-effort */ }
    }
    if ((groups || []).length) console.log(`[attendance] repeated-lateness checked ${groups.length} guard(s)`);
  } catch (err) {
    console.error('[attendance] repeated-lateness scheduler error:', (err as any)?.message || err);
  }
}

// Repeated-lateness check hourly.
nodeSetInterval(() => { runJob("RepeatedLateness", runRepeatedLatenessScheduler); }, 60 * 60 * 1000);
leaderTimeout(() => runJob("RepeatedLateness", runRepeatedLatenessScheduler), 90000);

/**
 * Document-expiry alerts (Feature #20) — once a day, scan every tenant's
 * compliance documents (certifications + insurance) and push the tenant's clients
 * an alert for any document whose days-to-expiry just crossed 30/15/7/1 days.
 * Anti-spam: fires only when daysToExpiry is EXACTLY a threshold, so each
 * (document,threshold) notifies once. Respects per-client mute (category
 * 'documents') inside clientNotifyService. Best-effort (never throws).
 */
async function runDocumentExpiryAlerts() {
  try {
    const database = await databaseInit();
    const { runDocumentExpiryAlerts: run } = require('./services/customerDocumentAlerts');
    await run(database);
  } catch (err) {
    console.error('[docExpiry] scheduler error:', (err as any)?.message || err);
  }
}

// Check document expiry once a day.
nodeSetInterval(() => { runJob("DocumentExpiryAlerts", runDocumentExpiryAlerts); }, 24 * 60 * 60 * 1000);
leaderTimeout(() => runJob("DocumentExpiryAlerts", runDocumentExpiryAlerts), 75000);

/**
 * Customer summary digest (Feature #21) — once a day, aggregate each active
 * client's site activity (incidents, patrols, hours, visits, on-duty changes) and
 * send a push ('digest.summary') + branded email digest. Cadence lives in
 * DIGEST_PERIOD_DAYS (digest service) — flip daily↔weekly there. Respects
 * per-client mute (category 'digest'). Best-effort (never throws).
 */
async function runCustomerSummaryDigest() {
  try {
    const database = await databaseInit();
    const { runCustomerSummaryDigest: run } = require('./services/customerSummaryDigest');
    await run(database);
  } catch (err) {
    console.error('[digest] scheduler error:', (err as any)?.message || err);
  }
}

// Send the summary digest once a day (leader instance only, via nodeSetInterval).
// NOTE: removed the boot-time `leaderTimeout(() => runCustomerSummaryDigest(), 105000)`
// — it fired the digest ~105s after EVERY restart/reload, so every deploy sent a
// fresh round of "resumen diario" emails (×2 with the cluster). The daily interval
// + the in-service "already sent today" guard are the single source of cadence now.
nodeSetInterval(() => { runJob("CustomerSummaryDigest", runCustomerSummaryDigest); }, 24 * 60 * 60 * 1000);

