/**
 * BullMQ-backed async job queue (Redis). Gives heavy/bursty background work
 * (bulk email, digests, fan-out) retries + exponential backoff + a dead-letter
 * (failed set) + cross-worker concurrency, plus visibility via the superadmin
 * "Colas" page. DEGRADES SAFELY: without REDIS_URL (or if enqueue fails) the job
 * runs INLINE via the registered handler, so nothing is silently dropped.
 *
 * Producers call enqueue(name, data); consumers register a handler once
 * (registerHandler(name, fn)). The worker (startQueueWorker, called in server.ts)
 * dispatches jobs by name. Handlers must be idempotent (a job can retry).
 */
import { Queue, Worker, QueueEvents } from 'bullmq';

const QUEUE_NAME = 'cguard';
const url = process.env.REDIS_URL;

let queue: Queue | null = null;
let worker: Worker | null = null;
const handlers: Record<string, (data: any) => Promise<any> | any> = {};

function connection(): any {
  const u = new URL(url as string);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: u.password } : {}),
    maxRetriesPerRequest: null,
  };
}

export function registerHandler(name: string, fn: (data: any) => Promise<any> | any): void {
  handlers[name] = fn;
}

export function getQueue(): Queue | null {
  if (!url) return null;
  if (queue) return queue;
  try {
    queue = new Queue(QUEUE_NAME, { connection: connection() });
    return queue;
  } catch {
    queue = null;
    return null;
  }
}

/**
 * Enqueue a job. When the queue is up it's added with retries/backoff; otherwise
 * (no Redis, or add() throws) it runs inline via the handler so work is never lost.
 */
export async function enqueue(name: string, data: any, opts: any = {}): Promise<void> {
  const q = getQueue();
  if (q) {
    try {
      await q.add(name, data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
        ...opts,
      });
      return;
    } catch (e: any) {
      console.error(`[queue] enqueue ${name} failed, running inline:`, e?.message || e);
    }
  }
  const h = handlers[name];
  if (h) {
    try { await h(data); } catch (e: any) { console.error(`[queue:inline:${name}]`, e?.message || e); }
  }
}

/** Start the consumer worker. Call once per process (each PM2 worker can run one). */
export function startQueueWorker(): void {
  if (!url || worker) return;
  try {
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const h = handlers[job.name];
        if (!h) throw new Error(`No handler registered for job "${job.name}"`);
        return h(job.data);
      },
      { connection: connection(), concurrency: Number(process.env.QUEUE_CONCURRENCY || 5) },
    );
    worker.on('failed', (job, err) => console.error(`[queue:${job?.name}] failed:`, err?.message || err));
  } catch (e: any) {
    console.error('[queue] worker start failed:', e?.message || e);
  }
}

// ── Observability helpers (the "Colas" page) ──────────────────────────────────
export async function queueStatus(): Promise<any> {
  const q = getQueue();
  if (!q) return { enabled: false, counts: null, failed: [] };
  try {
    const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    const failedJobs = await q.getFailed(0, 24);
    const failed = failedJobs.map((j) => ({
      id: j.id, name: j.name, failedReason: (j.failedReason || '').slice(0, 300),
      attemptsMade: j.attemptsMade, timestamp: j.timestamp,
    }));
    const isPaused = await q.isPaused();
    return { enabled: true, name: QUEUE_NAME, counts, failed, paused: isPaused };
  } catch (e: any) {
    return { enabled: false, error: e?.message || String(e), counts: null, failed: [] };
  }
}

export async function retryFailed(): Promise<number> {
  const q = getQueue();
  if (!q) return 0;
  const jobs = await q.getFailed(0, 999);
  let n = 0;
  for (const j of jobs) { try { await j.retry(); n++; } catch { /* skip */ } }
  return n;
}

export async function drainFailed(): Promise<number> {
  const q = getQueue();
  if (!q) return 0;
  const jobs = await q.getFailed(0, 999);
  let n = 0;
  for (const j of jobs) { try { await j.remove(); n++; } catch { /* skip */ } }
  return n;
}
