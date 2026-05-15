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
import { ensurePlatformEventsTable, cleanupOldPlatformEvents } from './lib/platformEventStore';
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

startServer(PORT, 5);

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

