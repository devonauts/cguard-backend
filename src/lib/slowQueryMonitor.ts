/**
 * In-memory slow-query monitor. Sequelize is run with `benchmark: true` so every
 * query reports its execution time; anything at/over the threshold (default
 * 100 ms = 0.1 s, override with SLOW_QUERY_MS) is captured here in a ring buffer
 * for the SuperAdmin observability "Queries" page. Per-PM2-worker (in-process).
 */
const THRESHOLD_MS = Number(process.env.SLOW_QUERY_MS || 100);
const MAX = 300;

export interface SlowQuery {
  sql: string;
  ms: number;
  at: string;
  // Attribution from the request context (which endpoint/tenant issued it) —
  // the whole point: you can now locate the code path behind a slow query.
  route?: string | null;
  method?: string | null;
  tenantId?: string | null;
  requestId?: string | null;
  queryNo?: number; // this query's index within its request (N+1 signal)
}

const buffer: SlowQuery[] = [];
let totalSlow = 0;
let maxMs = 0;

/** Called from the Sequelize benchmark logger for every query. */
export function recordQuery(sql: string, ms: number): void {
  // Count every query against the request (N+1 detection) even when it's fast.
  let ctx: any;
  try { ctx = require('./requestContext').getContext(); if (ctx) ctx.queryCount += 1; } catch { /* no context */ }
  if (typeof ms !== 'number' || ms < THRESHOLD_MS) return;
  totalSlow++;
  if (ms > maxMs) maxMs = ms;
  buffer.unshift({
    sql: String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    ms: Math.round(ms),
    at: new Date().toISOString(),
    route: ctx?.path ?? null,
    method: ctx?.method ?? null,
    tenantId: ctx?.tenantId ?? null,
    requestId: ctx?.requestId ?? null,
    queryNo: ctx?.queryCount ?? undefined,
  });
  if (buffer.length > MAX) buffer.pop();
}

export function getSlowQueries() {
  return {
    thresholdMs: THRESHOLD_MS,
    totalSlow,
    maxMs: Math.round(maxMs),
    captured: buffer.length,
    queries: buffer,
  };
}

export function clearSlowQueries(): { ok: true } {
  buffer.length = 0;
  totalSlow = 0;
  maxMs = 0;
  return { ok: true };
}
