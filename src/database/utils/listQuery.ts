import FileRepository from '../repositories/fileRepository';

/**
 * Shared helpers for LEAN list endpoints (enterprise standard — see
 * backend/docs/payload-perf-plan.md).
 *
 * The rule: a LIST endpoint returns only what the table renders, in O(1) queries.
 * - Select an explicit `attributes` whitelist on the root model AND every include
 *   (never SELECT * — it ships blobs like station.geofencePolygon, base64 photos,
 *   password/token columns).
 * - Get relations from a single `include` with scoped attributes — NEVER a per-row
 *   findByPk / getX() / file.findAll (that is the N+1 that runs ~5N queries/page).
 * - Sign file URLs only on the DETAIL fetch, or with `batchSignFiles` (one query)
 *   when a list surface actually renders thumbnails.
 */

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;

/**
 * Clamp a caller-supplied limit. Use ONLY on endpoints whose frontend paginates
 * (do not clamp lists the CRM fetches whole and paginates client-side until that
 * page has server pagination — clamping those would silently hide rows).
 */
export function clampLimit(limit: any, opts: { def?: number; max?: number } = {}): number {
  const def = opts.def ?? DEFAULT_PAGE;
  const max = opts.max ?? MAX_PAGE;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * Attach signed file URLs to a set of rows in ONE query instead of N. Replaces
 * the per-row `file.findAll` + `fillDownloadUrl` pattern. Mutates each row,
 * setting row[column] to the signed file descriptors for that row.
 *
 * @param database   req.database / options.database
 * @param rows       plain row objects (already .get({plain:true}))
 * @param belongsTo  the file owner table name (e.g. 'visitorLog', 'securityGuard')
 * @param column     the belongsToColumn (e.g. 'idPhoto', 'profileImage')
 * @param idKey      the row id field (default 'id')
 */
export async function batchSignFiles(
  database: any,
  rows: any[],
  belongsTo: string,
  column: string,
  idKey = 'id',
): Promise<any[]> {
  if (!rows || !rows.length) return rows;
  const ids = rows.map((r) => r[idKey]).filter(Boolean);
  if (!ids.length) return rows;

  const files = await database.file.findAll({
    where: { belongsTo, belongsToColumn: column, belongsToId: ids },
  });

  const byOwner = new Map<string, any[]>();
  for (const f of files) {
    const k = String(f.belongsToId);
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k)!.push(f);
  }

  await Promise.all(
    rows.map(async (r) => {
      const owned = byOwner.get(String(r[idKey])) || [];
      r[column] = await FileRepository.fillDownloadUrl(owned);
    }),
  );
  return rows;
}
