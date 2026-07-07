/**
 * Per-request context via AsyncLocalStorage. Seeded by the earliest middleware
 * (see api/index.ts) so any code deep in the call stack can attribute work to
 * the originating request WITHOUT threading req through every function:
 *   - the Sequelize benchmark logger tags each slow query with its route/tenant
 *   - the error tracker records route/method/tenant/user/requestId on each 500
 *   - the per-request query counter flags "high query count" (N+1) requests
 *
 * Everything is best-effort: if there is no active store (background jobs,
 * schedulers) the getters return undefined and callers fall back gracefully.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
  tenantId?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  startedAt: number;
  queryCount: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  // Short, sortable-enough, collision-safe id for correlation.
  return crypto.randomBytes(9).toString('base64url');
}

/** Run `fn` with a fresh request context. */
export function runWithContext<T>(seed: Partial<RequestContext>, fn: () => T): T {
  const ctx: RequestContext = {
    requestId: seed.requestId || newRequestId(),
    method: seed.method,
    path: seed.path,
    tenantId: seed.tenantId ?? null,
    userId: seed.userId ?? null,
    ip: seed.ip ?? null,
    userAgent: seed.userAgent ?? null,
    startedAt: Date.now(),
    queryCount: 0,
  };
  return storage.run(ctx, fn);
}

/** The active context, or undefined outside a request (jobs, boot). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Enrich the active context in place (e.g. tenantId/userId become known after auth). */
export function enrichContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (patch.tenantId !== undefined) ctx.tenantId = patch.tenantId;
  if (patch.userId !== undefined) ctx.userId = patch.userId;
  if (patch.path !== undefined) ctx.path = patch.path;
  if (patch.method !== undefined) ctx.method = patch.method;
}

/** Increment and return the per-request query counter (used for N+1 detection). */
export function bumpQueryCount(): number {
  const ctx = storage.getStore();
  if (!ctx) return 0;
  ctx.queryCount += 1;
  return ctx.queryCount;
}
