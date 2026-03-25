import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    const stationId = req.params.stationId;

    const replacements = { tenantId, stationId };

    // Query shifts that reference this station directly (or via station postSite linkage)
    const sqlShifts = `
      SELECT
        s.id as id,
        s.startTime,
        s.endTime,
        s.stationId as stationId,
        biStation.companyName as stationName,
        s.postSiteId as postSiteId,
        biPost.companyName as postSiteName,
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
      LEFT JOIN stations biStation ON biStation.id = s.stationId
      LEFT JOIN businessInfos biPost ON biPost.id = s.postSiteId
      LEFT JOIN users u ON u.id = s.guardId
      LEFT JOIN securityGuards sg ON sg.guardId = s.guardId AND sg.tenantId = :tenantId
      WHERE (s.stationId = :stationId OR biStation.id = :stationId)
        AND s.tenantId = :tenantId
      ORDER BY s.createdAt DESC
    `;

    let shiftRows: any[] = [];
    try {
      console.debug('[stationAssignedGuards] running shifts query', { tenantId, stationId });
      shiftRows = await req.database.sequelize.query(sqlShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[stationAssignedGuards] shifts query failed', (err && (err as any).message) || err);
      shiftRows = [];
    }

    // Also include guardShift records that reference this station
    const sqlGuardShifts = `
      SELECT
        gs.id as id,
        gs.punchInTime,
        gs.punchOutTime,
        gs.shiftSchedule,
        gs.stationNameId as stationId,
        bi.companyName as stationName,
        bi.postSiteId as postSiteId,
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
      LEFT JOIN stations bi ON bi.id = gs.stationNameId
      LEFT JOIN securityGuards sg ON sg.id = gs.guardNameId
      LEFT JOIN users gu ON gu.id = sg.guardId
      WHERE (gs.stationNameId = :stationId OR bi.id = :stationId)
        AND gs.tenantId = :tenantId
      ORDER BY gs.createdAt DESC
    `;

    let guardShiftRows: any[] = [];
    try {
      console.debug('[stationAssignedGuards] running guardShifts query', { tenantId, stationId });
      guardShiftRows = await req.database.sequelize.query(sqlGuardShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[stationAssignedGuards] guardShifts query failed', (err && (err as any).message) || err);
      guardShiftRows = [];
    }

    const combined = [
      ...(shiftRows || []),
      ...(guardShiftRows || []),
    ];

    console.debug(`[stationAssignedGuards] found ${combined.length} rows for station ${stationId}`);

    // Normalize result rows into consistent guard objects
    const normalizedMap = new Map();
    for (const r of combined) {
      try {
        const guardUserId = r.guardUserId || r.userId || r.guardId || null;
        const securityGuardRecordId = r.securityGuardRecordId || r.securityGuardId || r.security_guard_id || null;
        const primaryId = guardUserId || securityGuardRecordId || (r.id ? String(r.id) : null);
        if (!primaryId) continue;

        const fullName = r.fullName || r.displayName || ((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.name || r.username || r.email || null;

        const stationIdRow = r.stationId || r.station_id || null;
        const stationName = r.stationName || r.station_name || null;
        const postSiteId = r.postSiteId || r.post_site_id || null;

        const key = String(primaryId);
        if (!normalizedMap.has(key)) {
          normalizedMap.set(key, {
            id: key,
            guardUserId: guardUserId || null,
            securityGuardRecordId: securityGuardRecordId || null,
            fullName,
            stationId: stationIdRow ? String(stationIdRow) : null,
            stationName: stationName || null,
            postSiteId: postSiteId ? String(postSiteId) : null,
            source: r.source || 'shift',
            raw: r,
          });
        } else {
          const existing = normalizedMap.get(key);
          if ((!existing.stationId || existing.stationId === null) && stationIdRow) {
            existing.stationId = stationIdRow ? String(stationIdRow) : existing.stationId;
            existing.stationName = stationName || existing.stationName;
            existing.postSiteId = postSiteId ? String(postSiteId) : existing.postSiteId;
            normalizedMap.set(key, existing);
          }
        }
      } catch (e) {
        console.warn('[stationAssignedGuards] failed to normalize row', e && (e as any).message);
      }
    }

    const normalized = Array.from(normalizedMap.values());

    await ApiResponseHandler.success(req, res, { rows: normalized, count: normalized.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
