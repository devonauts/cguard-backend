/**
 * Standalone alarm-receiver process.
 *
 * Initializes the Sequelize DB/models exactly like the main server
 * (databaseInit) and starts the TCP+UDP alarm receiver. Run as its own PM2
 * process so panel/receiver traffic is isolated from the HTTP API.
 *
 *   Run:  npx ts-node src/alarmReceiver.ts
 *   Env:  ALARM_TCP_PORT (default 6543), ALARM_UDP_PORT (default 6543)
 */
require('dotenv').config();

import { databaseInit } from './database/databaseConnection';
import { startReceiver } from './services/alarm/receiver';
import { runEscalationSweep } from './services/alarm/escalation';

// Cache the initialized models bundle; databaseInit() itself memoizes, but we
// pass a resolver so each message reuses the same connection pool.
let dbPromise: Promise<any> | null = null;
function resolveDb(): Promise<any> {
  if (!dbPromise) dbPromise = Promise.resolve(databaseInit());
  return dbPromise;
}

async function boot() {
  // Eagerly initialize the DB so a bad connection fails fast at startup.
  await resolveDb();
  console.log('[alarmReceiver] database initialized');

  const tcpPort = Number(process.env.ALARM_TCP_PORT) || 6543;
  const udpPort = Number(process.env.ALARM_UDP_PORT) || 6543;

  const handles = startReceiver({ tcpPort, udpPort, resolveDb });

  // SLA escalation sweep every 45s (this single-instance process is the right
  // place — never duplicated across cluster workers).
  const escDb = await resolveDb();
  const escTimer = setInterval(() => { runEscalationSweep(escDb).catch(() => {}); }, 45000);

  if (typeof process.send === 'function') {
    process.send('ready');
  }

  const shutdown = async (sig: string) => {
    console.log(`[alarmReceiver] ${sig} received, shutting down...`);
    clearInterval(escTimer);
    try {
      await handles.close();
    } catch (e: any) {
      console.error('[alarmReceiver] shutdown error:', e?.message || e);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch((err) => {
  console.error('[alarmReceiver] boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
