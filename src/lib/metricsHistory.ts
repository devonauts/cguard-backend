/**
 * metricsHistory — the leader-elected per-minute snapshot writer + reader behind
 * the observability sparklines. captureSnapshot() rolls up system/pool/slow/error
 * numbers into one metricsSnapshots row and prunes >14d; getHistory() reads them
 * back for the charts. Called from server.ts via runJob('MetricsSnapshot').
 */
import os from 'os';
import fs from 'fs';
import v8 from 'v8';
import { getSlowQueries } from './slowQueryMonitor';
import { getJobs } from './jobsMonitor';

const RETENTION_DAYS = 14;
let _pruneCounter = 0;

function diskPct(): number | null {
  try {
    const st: any = (fs as any).statfsSync(process.cwd());
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    if (!total) return null;
    return Math.round(((total - free) / total) * 1000) / 10;
  } catch {
    return null;
  }
}

/** Build (and persist) one snapshot. Returns the plain metrics for alerting. */
export async function captureSnapshot(): Promise<any> {
  const models = require('../database/models').default;
  const db = models();
  const { Op } = db.Sequelize;

  const mem = process.memoryUsage();
  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const cores = os.cpus()?.length || 1;
  const load1 = os.loadavg()[0] || 0;

  // DB pool (Sequelize connection manager, same source as dbPerformance).
  let dbPoolUsing: number | null = null, dbPoolWaiting: number | null = null, dbPoolMax: number | null = null;
  try {
    const pool: any = (db.sequelize as any).connectionManager?.pool;
    if (pool) {
      dbPoolUsing = pool.using ?? pool.size ?? null;
      dbPoolWaiting = pool.pending ?? 0;
      dbPoolMax = pool.max ?? null;
    }
  } catch { /* ignore */ }

  // MySQL SERVER-GLOBAL connection saturation — the EARLY warning for the whole
  // box. max_connections is shared by every process (both API instances, the
  // alarm-receiver, the SIP bridge, schedulers), so the per-process pool metric
  // above can look healthy while MySQL is about to reject with "Too many
  // connections" — which is exactly what caused the mass-logout incident.
  let dbConnPct: number | null = null, dbThreadsConnected: number | null = null, dbMaxConnections: number | null = null;
  try {
    const [tcRows]: any = await db.sequelize.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'");
    const [mcRows]: any = await db.sequelize.query("SHOW VARIABLES LIKE 'max_connections'");
    dbThreadsConnected = tcRows?.[0]?.Value != null ? Number(tcRows[0].Value) : null;
    dbMaxConnections = mcRows?.[0]?.Value != null ? Number(mcRows[0].Value) : null;
    if (dbThreadsConnected != null && dbMaxConnections) {
      dbConnPct = Math.round((dbThreadsConnected / dbMaxConnections) * 1000) / 10;
    }
  } catch { /* non-MySQL dialect or insufficient privilege — skip */ }

  // Recent error count (last 60s) for the error-rate trend + spike alert.
  let errorCount = 0;
  try {
    if (db.errorEvent) {
      errorCount = await db.errorEvent.count({ where: { createdAt: { [Op.gte]: new Date(Date.now() - 60_000) } } });
    }
  } catch { /* ignore */ }

  const slow = getSlowQueries();
  const jobErrors = getJobs().filter((j) => j.lastStatus === 'error').length;

  const metrics = {
    hostMemPct: Math.round(((totalmem - freemem) / totalmem) * 1000) / 10,
    // Percent of the HARD heap ceiling (heap_size_limit), NOT of heapTotal.
    // heapUsed/heapTotal sits at ~90% on a healthy process (V8 keeps heapTotal
    // near heapUsed and only grows it on demand), so it's a false-alarm metric —
    // the number that signals real memory pressure is usage vs the limit.
    heapUsedPct: Math.round((mem.heapUsed / (v8.getHeapStatistics().heap_size_limit || mem.heapTotal)) * 1000) / 10,
    rss: mem.rss,
    loadPct: Math.round((load1 / cores) * 1000) / 10,
    diskPct: diskPct(),
    dbPoolUsing, dbPoolWaiting, dbPoolMax,
    dbConnPct, dbThreadsConnected, dbMaxConnections,
    dbSizeBytes: null as number | null,
    slowTotal: slow.totalSlow ?? 0,
    slowMax: slow.maxMs ?? 0,
    errorCount,
    jobErrors,
  };

  try {
    if (db.metricsSnapshot) {
      await db.metricsSnapshot.create(metrics);
      // Prune occasionally (every ~30 snapshots ≈ 30 min) to keep it cheap.
      if (++_pruneCounter % 30 === 0) {
        await db.metricsSnapshot.destroy({
          where: { createdAt: { [Op.lt]: new Date(Date.now() - RETENTION_DAYS * 86400_000) } },
        });
      }
    }
  } catch (e: any) {
    console.error('[metricsHistory] snapshot write failed:', e?.message || e);
  }

  return metrics;
}

/** GET history rows for the last `hours` (default 6, max 336=14d). */
export async function getHistory(hours = 6): Promise<any[]> {
  const models = require('../database/models').default;
  const db = models();
  if (!db.metricsSnapshot) return [];
  const { Op } = db.Sequelize;
  const h = Math.min(Math.max(Number(hours) || 6, 1), 336);
  const rows = await db.metricsSnapshot.findAll({
    where: { createdAt: { [Op.gte]: new Date(Date.now() - h * 3600_000) } },
    order: [['createdAt', 'ASC']],
    raw: true,
  });
  return rows;
}
