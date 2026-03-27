import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    // The incoming :id may be a postSite id or a station id (frontend calls this route for both).
    // Treat it as a generic locationId and look for matches on postSiteId OR stationId.
    const locationId = req.params.id;

    const replacements = { tenantId, locationId };

    // NOTE: No longer using tenant_user_post_sites pivot for assignments.
    // Use `shifts` and `guardShifts` as canonical sources of assignment data.

    // Also include assignments that come from shifts linked to this post site (station)
    // Include shifts that reference this post-site either via postSiteId or via stationId
    // (some historical data may store the link on stationId while newer rows use postSiteId).
    const sqlShifts = `
      SELECT
        s.id as id,
        s.startTime,
        s.endTime,
        s.stationId as stationId,
        s.postSiteId as postSiteId,
        biStation.companyName as stationName,
        biPost.companyName as postSiteName,
        ca.name as clientName,
        s.guardId as guardId,
        s.guardId as guardUserId,
        u.id as userId,
        sg.id as securityGuardId,
        u.firstName as firstName,
        u.lastName as lastName,
        u.email as email,
        u.phoneNumber as phoneNumber,
        'shift' as source,
        s.createdAt,
        s.updatedAt
      FROM shifts s
      -- stationId on shifts references stations
      LEFT JOIN stations biStation ON biStation.id = s.stationId
      LEFT JOIN businessInfos biPost ON biPost.id = s.postSiteId
      LEFT JOIN clientAccounts ca ON ca.id = COALESCE(biPost.clientAccountId, biStation.clientAccountId)
      LEFT JOIN users u ON u.id = s.guardId
      LEFT JOIN securityGuards sg ON sg.guardId = s.guardId AND sg.tenantId = :tenantId
      WHERE (
        s.postSiteId = :locationId
        OR s.stationId = :locationId
        OR biStation.id = :locationId
        OR biStation.postSiteId = :locationId
      )
        AND s.tenantId = :tenantId
      ORDER BY s.createdAt DESC
    `;

    let shiftRows: any[] = [];
    try {
      console.debug('[postSiteAssignedGuards] running shifts query', { tenantId, locationId });
      shiftRows = await req.database.sequelize.query(sqlShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[postSiteAssignedGuards] shifts query failed', (err && (err as any).message) || err);
      shiftRows = [];
    }

    // Include guardShift records that reference this station
    const sqlGuardShifts = `
      SELECT
        gs.id as id,
        gs.punchInTime,
        gs.punchOutTime,
        gs.shiftSchedule,
        gs.stationNameId as businessInfoId,
        bi.companyName as postSiteName,
        ca.name as clientName,
        gs.guardNameId as securityGuardRecordId,
        sg.guardId as guardId,
        sg.guardId as guardUserId,
        gu.id as userId,
        gu.firstName as firstName,
        gu.lastName as lastName,
        gu.email as email,
        gu.phoneNumber as phoneNumber,
        'guardShift' as source,
        gs.createdAt,
        gs.updatedAt
      FROM guardShifts gs
      -- stationNameId references the stations table
      LEFT JOIN stations bi ON bi.id = gs.stationNameId
      LEFT JOIN clientAccounts ca ON ca.id = bi.clientAccountId
      LEFT JOIN securityGuards sg ON sg.id = gs.guardNameId
      LEFT JOIN users gu ON gu.id = sg.guardId
      WHERE (
        gs.stationNameId = :locationId
        OR bi.id = :locationId
        OR bi.postSiteId = :locationId
      )
        AND gs.tenantId = :tenantId
      ORDER BY gs.createdAt DESC
    `;

    let guardShiftRows: any[] = [];
    try {
        console.debug('[postSiteAssignedGuards] running guardShifts query', { tenantId, locationId });
        guardShiftRows = await req.database.sequelize.query(sqlGuardShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[postSiteAssignedGuards] guardShifts query failed', (err && (err as any).message) || err);
      guardShiftRows = [];
    }

    const combined = [
      ...(shiftRows || []),
      ...(guardShiftRows || []),
    ];

    console.debug(`[postSiteAssignedGuards] found ${combined.length} combined rows for location ${locationId}`);

    // Normalize combined rows into a consistent guard object so frontend can rely on fields
    const normalizedMap = new Map();
    for (const r of combined) {
      try {
        // Prefer userId (the user table id) as primary guard identifier when available
        const guardUserId = r.guardUserId || r.userId || r.guardId || r.guard_user_id || null;
        const securityGuardRecordId = r.securityGuardId || r.security_guard_id || r.securityGuardRecordId || r.securityGuardRecordId || null;
        const tenantUserId = r.tenantUserId || null;

        const primaryId = guardUserId || securityGuardRecordId || tenantUserId || (r.id ? String(r.id) : null);
        if (!primaryId) continue;

        const fullName = r.fullName || r.displayName || ((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.name || r.username || r.email || null;

        // Normalize station/postSite fields into consistent names
        const stationId = r.stationId || r.station_id || r.businessInfoId || r.station_pk || r.stationNameId || null;
        const stationName = r.stationName || r.station_name || r.companyName || r.postSiteName || r.postSiteName || null;
        const postSiteId = r.postSiteId || r.post_site_id || r.businessInfoId || r.siteId || null;

        const key = String(primaryId);
        // Compute canonical identifiers to make frontend matching reliable
        const stationIdCanonical = stationId ? String(stationId) : (r.raw && r.raw.station && (r.raw.station.id || r.raw.station.stationId) ? String(r.raw.station.id || r.raw.station.stationId) : null);
        const guardIdCanonical = guardUserId ? String(guardUserId) : (r.userId ? String(r.userId) : (r.guardId ? String(r.guardId) : (securityGuardRecordId ? String(securityGuardRecordId) : null)));

        if (!normalizedMap.has(key)) {
          normalizedMap.set(key, {
            id: key,
            guardUserId: guardUserId || null,
            securityGuardRecordId: securityGuardRecordId || null,
            tenantUserId: tenantUserId || null,
            guardIdCanonical: guardIdCanonical || null,
            fullName,
            stationId: stationId ? String(stationId) : null,
            stationIdCanonical: stationIdCanonical || null,
            stationName: stationName || null,
            postSiteId: postSiteId ? String(postSiteId) : null,
            source: r.source || 'assigned',
            raw: r,
          });
        } else {
          const existing = normalizedMap.get(key);
          if ((!existing.stationId || existing.stationId === null) && stationId) {
            existing.stationId = stationId ? String(stationId) : existing.stationId;
            existing.stationIdCanonical = existing.stationIdCanonical || stationIdCanonical || existing.stationId;
            existing.stationName = stationName || existing.stationName;
            existing.postSiteId = postSiteId ? String(postSiteId) : existing.postSiteId;
            existing.guardIdCanonical = existing.guardIdCanonical || guardIdCanonical || existing.guardIdCanonical;
            normalizedMap.set(key, existing);
          }
        }
      } catch (e) {
        console.warn('[postSiteAssignedGuards] failed to normalize row', e && (e as any).message);
      }
    }

    const normalized = Array.from(normalizedMap.values());

    await ApiResponseHandler.success(req, res, { rows: normalized, count: normalized.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
