/**
 * Compose a full RONDA (patrol round) detail: the tourAssignment + its route + guard +
 * every checkpoint (scanned or not) with the scan's time, photo/note (raw scannedData,
 * resolved by each app) and geo verdict. Shared by the worker, CRM, client and
 * supervisor detail screens. `stationIds` optionally scopes access (guard/client).
 */
export async function buildRondaDetail(
  db: any,
  tenantId: string,
  assignmentId: string,
  opts?: { stationIds?: string[]; securityGuardId?: string },
): Promise<any | null> {
  const assignment = await db.tourAssignment.findOne({ where: { id: assignmentId, tenantId } });
  if (!assignment) return null;
  const a = assignment.get({ plain: true });

  // Access scoping.
  if (opts?.securityGuardId && String(a.securityGuardId) !== String(opts.securityGuardId)) return null;
  if (opts?.stationIds && opts.stationIds.length && a.stationId && !opts.stationIds.includes(String(a.stationId))) return null;

  const [tour, guard, station] = await Promise.all([
    a.siteTourId ? db.siteTour.findByPk(a.siteTourId) : null,
    a.securityGuardId ? db.securityGuard.findByPk(a.securityGuardId) : null,
    a.stationId ? db.station.findByPk(a.stationId) : null,
  ]);
  const tourP = tour ? tour.get({ plain: true }) : null;

  const tags = a.siteTourId
    ? await db.siteTourTag.findAll({ where: { siteTourId: a.siteTourId, tenantId }, order: [['createdAt', 'ASC']] })
    : [];
  const scans = await db.tagScan.findAll({ where: { tourAssignmentId: a.id, tenantId }, order: [['scannedAt', 'ASC']] });

  // The guard's per-checkpoint NOTE + PHOTO live in scannedData.extra ({notes,
  // photoFileToken}). Parse them into ready-to-render `note` + signed `photoUrl` so
  // every consumer (client patrol detail included) shows the proof without re-parsing.
  const { getConfig } = require('../config');
  const backendBase = String((getConfig() as any).BACKEND_URL || '').replace(/\/+$/, '');
  const fileDownloadPath = backendBase.endsWith('/api') ? '/file/download' : '/api/file/download';
  const parseExtra = (sd: any): any => {
    if (!sd) return {};
    try { const o = typeof sd === 'string' ? JSON.parse(sd) : sd; return (o && o.extra) || {}; } catch { return {}; }
  };

  const scanByTag = new Map<string, any>();
  const scanRows = scans.map((s: any) => {
    const sp = s.get({ plain: true });
    const extra = parseExtra(sp.scannedData);
    const row = {
      id: sp.id,
      siteTourTagId: sp.siteTourTagId,
      scannedAt: sp.scannedAt,
      validLocation: sp.validLocation,
      distanceMeters: sp.distanceMeters,
      scannedData: sp.scannedData || null,
      note: (extra.notes && String(extra.notes).trim()) || null,
      photoUrl: extra.photoFileToken ? `${backendBase}${fileDownloadPath}?fileToken=${encodeURIComponent(String(extra.photoFileToken))}` : null,
    };
    if (sp.siteTourTagId) scanByTag.set(String(sp.siteTourTagId), row);
    return row;
  });

  const checkpoints = tags.map((t: any) => {
    const tp = t.get({ plain: true });
    const scan = scanByTag.get(String(tp.id)) || null;
    return {
      id: tp.id,
      name: tp.name,
      instructions: tp.instructions || null,
      latitude: tp.latitude,
      longitude: tp.longitude,
      scanned: !!scan,
      scan,
    };
  });

  // Scans whose checkpoint was removed from the route — surface them so nothing is lost.
  const orphanScans = scanRows.filter(
    (s) => !s.siteTourTagId || !tags.find((t: any) => String(t.id) === String(s.siteTourTagId)),
  );

  return {
    assignment: { id: a.id, status: a.status, startAt: a.startAt, endAt: a.endAt, createdAt: a.createdAt },
    tour: tourP ? { id: tourP.id, name: tourP.name, description: tourP.description } : null,
    guard: guard ? { id: guard.id, name: guard.fullName } : null,
    station: station ? { id: station.id, name: station.stationName } : null,
    checkpoints,
    orphanScans,
    scanCount: scanRows.length,
    totalCheckpoints: tags.length,
  };
}
