/**
 * Lightweight background-job monitor. Schedulers run via runJob(name, fn) so the
 * SuperAdmin observability page can show each job's last run, duration, status
 * and error/run counts. Per-PM2-worker (in-process); a cluster-claimed job only
 * records on the worker that actually ran it.
 */
export interface JobStat {
  name: string;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastStatus?: 'ok' | 'error' | 'running';
  lastError?: string | null;
  runs: number;
  errors: number;
}

const jobs: Record<string, JobStat> = {};

function ensure(name: string): JobStat {
  return (jobs[name] ||= { name, runs: 0, errors: 0, lastStatus: undefined });
}

/** Wrap a scheduler tick so its health is tracked. Never throws to the caller. */
export async function runJob(name: string, fn: () => Promise<void> | void): Promise<void> {
  const j = ensure(name);
  j.lastStatus = 'running';
  const started = Date.now();
  try {
    await fn();
    j.lastStatus = 'ok';
    j.lastError = null;
    j.runs++;
  } catch (e: any) {
    j.lastStatus = 'error';
    j.lastError = (e && e.message) || String(e);
    j.errors++;
    console.error(`[job:${name}] error:`, j.lastError);
  } finally {
    j.lastRunAt = new Date().toISOString();
    j.lastDurationMs = Date.now() - started;
    void publishJobs();
  }
}

// Publish this worker's job stats to Redis so the observability endpoint shows a
// COMPLETE picture regardless of which worker (leader or not) serves the request.
// Schedulers run only on the leader, so without this a non-leader worker returned
// an empty/misleading Jobs table.
async function publishJobs(): Promise<void> {
  try {
    const { getObsRedis, OBS_INSTANCE } = require('./obsRedis');
    const r = await getObsRedis();
    if (r) await r.set(`obs:jobs:${OBS_INSTANCE}`, JSON.stringify(getJobs()), { EX: 180 });
  } catch { /* best-effort */ }
}

/** Merge every worker's job stats from Redis (latest run wins), + local. */
export async function getMergedJobs(): Promise<JobStat[]> {
  const local = getJobs();
  try {
    const { getObsRedis } = require('./obsRedis');
    const r = await getObsRedis();
    if (!r) return local;
    const keys: string[] = await r.keys('obs:jobs:*');
    if (!keys.length) return local;
    const byName: Record<string, JobStat> = {};
    for (const j of local) byName[j.name] = j;
    for (const k of keys) {
      try {
        const arr: JobStat[] = JSON.parse(await r.get(k)) || [];
        for (const j of arr) {
          const prev = byName[j.name];
          if (!prev || (j.lastRunAt || '') > (prev.lastRunAt || '')) byName[j.name] = j;
        }
      } catch { /* skip bad key */ }
    }
    return Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return local;
  }
}

/** Register a job so it appears (as "never run") before its first tick. */
export function registerJob(name: string): void {
  ensure(name);
}

export function getJobs(): JobStat[] {
  return Object.values(jobs).sort((a, b) => a.name.localeCompare(b.name));
}
