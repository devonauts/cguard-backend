/**
 * Per-PM2-worker metrics. Each worker publishes a snapshot (RAM breakdown, V8
 * heap spaces, CPU%, slow-query counters) to Redis every 10s under
 * `obs:worker:<instance>` (TTL 30s so a dead worker drops off). The observability
 * endpoint reads ALL keys to render one card per worker. Without REDIS_URL it
 * degrades to just this single worker.
 *
 * The V8 heap-space breakdown answers "what is consuming the RAM": old_space =
 * long-lived JS objects (a leak grows here), large_object_space = big buffers/
 * strings, plus `external`/`arrayBuffers` = C++/Buffer memory outside the heap.
 */
import v8 from 'v8';
import { createClient } from 'redis';
import { getSlowQueries } from './slowQueryMonitor';

const INSTANCE = String(process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.pid);
const KEY = `obs:worker:${INSTANCE}`;
const PATTERN = 'obs:worker:*';
const TTL_SECONDS = 30;

let client: any = null;
let prevCpu = process.cpuUsage();
let prevTime = Date.now();
let lastCpuPct = 0;
let lastSnap: any = null;

function refreshCpu(): void {
  const now = Date.now();
  const cpu = process.cpuUsage(prevCpu); // delta since last refresh
  const elapsedMs = now - prevTime;
  prevCpu = process.cpuUsage();
  prevTime = now;
  // % of ONE core (can exceed 100 on multi-threaded work).
  lastCpuPct = elapsedMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10 : 0;
}

function buildSnapshot(): any {
  const mem = process.memoryUsage();
  const heapSpaces = v8.getHeapSpaceStatistics().map((s) => ({
    name: s.space_name,
    used: s.space_used_size,
    total: s.space_size,
  }));
  const slow = getSlowQueries();
  const other = Math.max(0, mem.rss - mem.heapTotal - mem.external); // stack, code, etc.
  return {
    instance: INSTANCE,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    cpuPct: lastCpuPct,
    mem: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: (mem as any).arrayBuffers || 0,
      other,
    },
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    heapSpaces,
    slow: { totalSlow: slow.totalSlow, maxMs: slow.maxMs, captured: slow.captured, thresholdMs: slow.thresholdMs },
    at: new Date().toISOString(),
  };
}

async function getClient(): Promise<any> {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (client) return client;
  try {
    client = createClient({ url });
    client.on('error', () => {});
    await client.connect();
    return client;
  } catch {
    client = null;
    return null;
  }
}

/** Start the publish loop. Call once at startup (each worker runs it). */
export function startWorkerMetrics(): void {
  prevCpu = process.cpuUsage();
  prevTime = Date.now();
  const tick = async () => {
    try {
      refreshCpu();
      lastSnap = buildSnapshot();
      const c = await getClient();
      if (c) await c.set(KEY, JSON.stringify(lastSnap), { EX: TTL_SECONDS });
    } catch {
      /* best-effort */
    }
  };
  void tick();
  setInterval(tick, 10000);
}

/** All live workers (from Redis), or just this one when Redis is unavailable. */
export async function getAllWorkers(): Promise<{ redis: boolean; workers: any[] }> {
  const local = lastSnap || buildSnapshot();
  const c = await getClient();
  if (!c) return { redis: false, workers: [local] };
  try {
    const keys: string[] = await c.keys(PATTERN);
    if (!keys.length) return { redis: true, workers: [local] };
    const vals: (string | null)[] = await c.mGet(keys);
    const workers = vals
      .map((v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } })
      .filter(Boolean)
      .sort((a: any, b: any) => String(a.instance).localeCompare(String(b.instance), undefined, { numeric: true }));
    return { redis: true, workers: workers.length ? workers : [local] };
  } catch {
    return { redis: true, workers: [local] };
  }
}
