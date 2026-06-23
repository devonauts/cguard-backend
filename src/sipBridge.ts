/**
 * Standalone RoIP/SIP bridge process.
 *
 * Brings up a SIP UA + RTP session per ACTIVE radioDevice and relays audio between
 * the physical radio gateway and the tenant's app PTT channel (lib/radioVoice).
 * MUST run as its own single-instance (fork) PM2 app — it owns UDP/SIP/RTP sockets
 * which cannot be load-balanced across cluster workers (same constraint as the
 * alarm-receiver).
 *
 *   Run:  npx ts-node src/sipBridge.ts
 *   Needs: REDIS_URL (cross-process audio fanout), DB, and per-tenant radioDevice
 *          rows with reachable gateways + open SIP/RTP UDP ports.
 */
require('dotenv').config();

import { databaseInit } from './database/databaseConnection';
import { SipBridge } from './services/radio/sipBridgeService';

let dbPromise: Promise<any> | null = null;
function resolveDb(): Promise<any> {
  if (!dbPromise) dbPromise = Promise.resolve(databaseInit());
  return dbPromise;
}

async function boot() {
  const db = await resolveDb();
  console.log('[sipBridge] database initialized');

  if (!process.env.REDIS_URL) {
    console.warn('[sipBridge] REDIS_URL not set — app⇄radio audio fanout is disabled (single-box only).');
  }

  const bridge = new SipBridge(db);
  await bridge.start();
  console.log('[sipBridge] started; relaying active radio devices');

  // Periodically reconcile with the DB (devices added/removed/toggled) as a
  // fallback to the Redis control channel.
  const reloadTimer = setInterval(() => { bridge.reloadAll().catch(() => {}); }, 60000);

  if (typeof process.send === 'function') process.send('ready');

  const shutdown = async (sig: string) => {
    console.log(`[sipBridge] ${sig} received, shutting down...`);
    clearInterval(reloadTimer);
    try { await bridge.stop(); } catch (e: any) { console.error('[sipBridge] shutdown error:', e?.message || e); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch((err) => {
  console.error('[sipBridge] boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
