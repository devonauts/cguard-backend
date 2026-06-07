/**
 * Schedule rest-rule + sacafranco-consistency validation (Phase 6 — reqs 3 & 9).
 *
 * Surfaces, before a draft is published, the things that break the core promise
 * "everybody gets their rest day, and all sacafrancos work the same way":
 *   - double-booking: a guard with shifts at two different stations the same day
 *   - weekly rest:    a guard working more than N consecutive days with no rest
 *   - sf consistency: sacafrancos in the same sitio on different turno styles
 * Non-destructive: it reports warnings; the human resolves them before publish.
 */
export interface ValidationShift {
  guardId?: string | null;
  stationId?: string | null;
  startTime: Date | string;
}

export interface ScheduleWarnings {
  doubleBookings: { guardId: string; days: number }[];
  restViolations: { guardId: string; maxConsecutive: number }[];
  sfStyleInconsistencies: { postSiteId: string; styleCount: number }[];
  guardsWithIssues: number;
  maxConsecutiveAllowed: number;
}

const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const dayIndex = (k: string) => Math.floor(new Date(`${k}T00:00:00Z`).getTime() / 86_400_000);

/**
 * Detect double-bookings and weekly-rest violations across a set of shifts.
 * `maxConsecutive` is the most consecutive work-days allowed before a mandatory
 * rest day (Ecuador weekly rest → default 7).
 */
export function detectRestWarnings(
  shifts: ValidationShift[],
  maxConsecutive = 7,
): Pick<ScheduleWarnings, 'doubleBookings' | 'restViolations'> {
  const byGuard = new Map<string, Map<string, Set<string>>>(); // guard → day → stationIds
  for (const s of shifts) {
    if (!s.guardId) continue;
    const g = String(s.guardId);
    if (!byGuard.has(g)) byGuard.set(g, new Map());
    const dm = byGuard.get(g)!;
    const k = dayKey(s.startTime);
    if (!dm.has(k)) dm.set(k, new Set());
    if (s.stationId) dm.get(k)!.add(String(s.stationId));
  }

  const doubleBookings: { guardId: string; days: number }[] = [];
  const restViolations: { guardId: string; maxConsecutive: number }[] = [];

  for (const [guardId, dm] of byGuard.entries()) {
    let dbDays = 0;
    for (const stations of dm.values()) if (stations.size > 1) dbDays++;
    if (dbDays > 0) doubleBookings.push({ guardId, days: dbDays });

    const idxs = Array.from(dm.keys()).map(dayIndex).sort((a, b) => a - b);
    let maxRun = idxs.length ? 1 : 0;
    let run = idxs.length ? 1 : 0;
    for (let i = 1; i < idxs.length; i++) {
      run = idxs[i] === idxs[i - 1] + 1 ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    if (maxRun > maxConsecutive) restViolations.push({ guardId, maxConsecutive: maxRun });
  }

  return { doubleBookings, restViolations };
}

/**
 * Flag sitios where the active sacafrancos are NOT all on the same turno style
 * (the per-post-site consistency rule). Best-effort — returns [] on any error.
 */
export async function detectSfStyleInconsistencies(
  db: any,
  tenantId: string,
): Promise<{ postSiteId: string; styleCount: number }[]> {
  try {
    const sfAssignments = await db.guardAssignment.findAll({
      where: { tenantId, status: 'active', deletedAt: null, isRelief: true },
      attributes: ['id', 'rotationStyleId', 'stationId'],
    });
    if (!sfAssignments.length) return [];

    const stationIds = Array.from(new Set(sfAssignments.map((a: any) => a.stationId).filter(Boolean)));
    const stations = await db.station.findAll({ where: { id: stationIds, tenantId }, attributes: ['id', 'postSiteId'] });
    const sitioOf = new Map<string, string>(stations.map((s: any) => [s.id, s.postSiteId || 'none']));

    const bySitio = new Map<string, Set<string>>();
    for (const a of sfAssignments) {
      const sitio = sitioOf.get(a.stationId) || 'none';
      if (!bySitio.has(sitio)) bySitio.set(sitio, new Set());
      bySitio.get(sitio)!.add(a.rotationStyleId || 'none');
    }
    const out: { postSiteId: string; styleCount: number }[] = [];
    for (const [postSiteId, styles] of bySitio.entries()) {
      if (styles.size > 1) out.push({ postSiteId, styleCount: styles.size });
    }
    return out;
  } catch {
    return [];
  }
}
