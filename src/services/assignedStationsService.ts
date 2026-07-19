/**
 * Single source of truth for guard↔station assignment lookups.
 *
 * ALWAYS guardAssignment (status 'active'). The legacy
 * `stationAssignedGuardsUser` pivot is DEAD: its writers were removed on
 * 2026-07-18 (securityGuardCreate + stationRepository) and every reader was
 * migrated to these helpers. Do NOT reintroduce `station.assignedGuards`
 * (the belongsToMany include) in read paths — it shows ghost/stale guards.
 */

/** Station ids the guard (users.id) is actively assigned to. */
export async function stationIdsForGuard(
  database: any,
  tenantId: string,
  guardUserId: string,
): Promise<string[]> {
  if (!guardUserId) return [];
  const rows = await database.guardAssignment
    .findAll({
      where: { tenantId, guardId: guardUserId, status: 'active' },
      attributes: ['stationId'],
    })
    .catch(() => []);
  return [...new Set(rows.map((r: any) => String(r.stationId)).filter(Boolean))] as string[];
}

/** Map stationId → distinct assigned guard user ids, for a set of stations. */
export async function guardUserIdsByStation(
  database: any,
  tenantId: string,
  stationIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!stationIds?.length) return map;
  const rows = await database.guardAssignment
    .findAll({
      where: { tenantId, stationId: stationIds, status: 'active' },
      attributes: ['stationId', 'guardId'],
    })
    .catch(() => []);
  for (const r of rows) {
    const k = String(r.stationId);
    if (!map.has(k)) map.set(k, []);
    const list = map.get(k)!;
    const g = String(r.guardId);
    if (!list.includes(g)) list.push(g);
  }
  return map;
}

/** Flat distinct guard user ids assigned to any of the stations. */
export async function guardUserIdsForStations(
  database: any,
  tenantId: string,
  stationIds: string[],
): Promise<string[]> {
  const byStation = await guardUserIdsByStation(database, tenantId, stationIds);
  const all = new Set<string>();
  for (const list of byStation.values()) for (const g of list) all.add(g);
  return [...all];
}
