/**
 * Shared helpers for the supervisor mobile-app API.
 *
 * NOTE: `routePointVisit` (db.routePointVisit), `routePoint.siteType`/`tasks`
 * and `src/services/routeStopResolver.ts` (resolveStop) are provided by a
 * sibling task. We access the model dynamically off the `req.database` bag and
 * dynamic-require the resolver so this module compiles and runs even before the
 * sibling lands (with a sensible fallback in the meantime).
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Local YYYY-MM-DD for "today" (server timezone; DATEONLY comparison). */
export function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The three-letter day key ('mon', ...) for a given date (today by default). */
export function dayKeyFor(d: Date = new Date()): string {
  return DAY_KEYS[d.getDay()];
}

/**
 * Does the route run today? A route with no `days` (or an empty list) runs every
 * day; otherwise its `days` array (['mon','tue',...]) must include today.
 */
export function routeRunsToday(route: any, now: Date = new Date()): boolean {
  let days: any = route.days;
  if (typeof days === 'string') {
    try {
      days = JSON.parse(days);
    } catch {
      days = null;
    }
  }
  if (!Array.isArray(days) || days.length === 0) return true;
  return days.map((x: any) => String(x).toLowerCase()).includes(dayKeyFor(now));
}

/**
 * Resolve a stop's display fields (name/address/lat/lng/siteType/tasks) via the
 * sibling routeStopResolver, falling back to the routePoint's own columns.
 */
export async function resolveStopSafe(db: any, tenantId: string, point: any): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../services/routeStopResolver');
    const fn = mod.resolveStop || (mod.default && mod.default.resolveStop) || mod.default;
    if (typeof fn === 'function') {
      // routeStopResolver.resolveStop signature is (db, tenantId, point).
      const resolved = await fn(db, tenantId, point);
      if (resolved) {
        // The resolver returns { name, address, lat, lng }; carry siteType/tasks
        // through (from the resolved record or the point's own columns) so the
        // route serializer always has them.
        return {
          ...resolved,
          siteType: resolved.siteType ?? point.siteType ?? null,
          tasks:
            resolved.tasks ?? (Array.isArray(point.tasks) ? point.tasks : point.tasks ?? []),
        };
      }
    }
  } catch {
    /* resolver not available yet — fall through to fallback */
  }
  return {
    name: point.address || `Parada ${point.order}`,
    address: point.address ?? null,
    lat: point.lat ?? null,
    lng: point.lng ?? null,
    siteType: point.siteType ?? null,
    tasks: Array.isArray(point.tasks) ? point.tasks : [],
  };
}

/** IRepositoryOptions-shaped bag for FileRepository calls from a route handler. */
export function fileOptionsFor(req: any): any {
  return {
    database: req.database,
    currentUser: req.currentUser,
    currentTenant: { id: req.currentTenant.id },
  };
}

/** Normalize a point's tasks JSON into [{ id, label }]. */
export function normalizeTasks(point: any): Array<{ id: any; label: string }> {
  let tasks: any = point.tasks;
  if (typeof tasks === 'string') {
    try {
      tasks = JSON.parse(tasks);
    } catch {
      tasks = [];
    }
  }
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t: any, i: number) =>
    typeof t === 'string'
      ? { id: i, label: t }
      : { id: t.id ?? i, label: t.label ?? t.name ?? String(t) },
  );
}
