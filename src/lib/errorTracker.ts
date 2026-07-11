/**
 * errorTracker — the write path behind the superadmin "Errores" page. Called
 * from the single 500 choke point (ApiResponseHandler.error) and the two process
 * crash handlers (server.ts). Best-effort and non-throwing: it must NEVER add a
 * failure mode to request handling, so every DB write is fire-and-forget and
 * wrapped. A small in-memory ring keeps the most recent errors even if the DB
 * write fails, so the page degrades gracefully.
 *
 * Fingerprinting groups "the same" error: error name + a normalized message
 * (numbers/uuids/quoted values collapsed) + the top app stack frame. This lets
 * the UI show top patterns and rates instead of an undifferentiated firehose.
 */
import crypto from 'crypto';
import { getContext } from './requestContext';

export interface CaptureMeta {
  source?: 'request' | 'unhandledRejection' | 'uncaughtException' | 'manual';
  statusCode?: number;
  route?: string;
  method?: string;
  tenantId?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const RING_MAX = 200;
const ring: any[] = [];

function normalizeMessage(msg: string): string {
  return String(msg || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/'[^']*'/g, "'?'")
    .replace(/"[^"]*"/g, '"?"')
    .slice(0, 300);
}

function topAppFrame(stack: string): string {
  const lines = String(stack || '').split('\n');
  // First frame that lives in our source (skip node internals / node_modules).
  for (const l of lines) {
    if (/\bat\b/.test(l) && /(src|dist)\//.test(l) && !/node_modules/.test(l)) {
      return l.trim().replace(/\(.*?\)/, '').slice(0, 160);
    }
  }
  return (lines[1] || '').trim().slice(0, 160);
}

export function fingerprint(err: any): string {
  const name = (err && err.name) || 'Error';
  const msg = normalizeMessage(err && err.message);
  const frame = topAppFrame(err && err.stack);
  return crypto.createHash('sha1').update(`${name}|${msg}|${frame}`).digest('hex').slice(0, 32);
}

export function recentRing(limit = 50): any[] {
  return ring.slice(0, limit);
}

/**
 * Capture an error. Non-blocking: builds the row, pushes to the ring, and
 * fire-and-forget persists to errorEvents. Swallows all its own failures.
 */
export function capture(err: any, meta: CaptureMeta = {}): void {
  try {
    const ctx = getContext();
    const row = {
      fingerprint: fingerprint(err),
      name: ((err && err.name) || 'Error').slice(0, 128),
      message: (err && err.message ? String(err.message) : String(err)).slice(0, 2000),
      stack: (err && err.stack ? String(err.stack) : '').slice(0, 6000),
      statusCode: meta.statusCode ?? 500,
      method: (meta.method ?? ctx?.method ?? '').slice(0, 8) || null,
      route: (meta.route ?? ctx?.path ?? '').slice(0, 255) || null,
      source: meta.source || 'request',
      tenantId: meta.tenantId ?? ctx?.tenantId ?? null,
      userId: meta.userId ?? ctx?.userId ?? null,
      ip: (meta.ip ?? ctx?.ip ?? null),
      userAgent: (meta.userAgent ?? ctx?.userAgent ?? '')?.slice(0, 255) || null,
      requestId: meta.requestId ?? ctx?.requestId ?? null,
      pmInstance: process.env.NODE_APP_INSTANCE ?? null,
      createdAt: new Date(),
    };

    // In-memory fallback (newest first).
    ring.unshift(row);
    if (ring.length > RING_MAX) ring.length = RING_MAX;

    // Persist best-effort. Lazy-require models to avoid a boot-time cycle.
    // Skipped under NODE_ENV=test: the synchronous first require of the whole
    // model graph through ts-node blocks the event loop for 10s+ and there is
    // no test DB to insert into anyway (the in-memory ring above still records).
    if (process.env.NODE_ENV === 'test') return;
    try {
      const models = require('../database/models').default;
      const db = models();
      db.errorEvent.create(row).catch(() => {});
    } catch {
      /* models not ready (very early boot) — the ring still has it */
    }
  } catch {
    /* never let telemetry break the caller */
  }
}
