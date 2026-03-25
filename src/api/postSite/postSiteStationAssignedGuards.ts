import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;
    const stationId = req.params.stationId;

    const replacements = { tenantId, postSiteId, stationId };

    // Build filters: validate by station OR by postSite (not require both)
    const stationFilter = stationId ? `AND (s.stationId = :stationId OR biStation.id = :stationId)` : '';
    const postSiteFilter = (!stationId && postSiteId) ? `AND (s.postSiteId = :postSiteId OR biStation.postSiteId = :postSiteId)` : '';

    // Query shifts that reference this station or (if no station provided) the postSite
    const sqlShifts = `
      SELECT
        s.id as id,
        s.startTime,
        s.endTime,
        s.stationId as stationId,
        biStation.stationName as stationName,
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
      WHERE s.tenantId = :tenantId
        ${stationFilter}
        ${postSiteFilter}
      ORDER BY s.createdAt DESC
    `;

    let shiftRows: any[] = [];
    try {
      console.debug('[postSiteStationAssignedGuards] running shifts query', { tenantId, postSiteId, stationId });
      shiftRows = await req.database.sequelize.query(sqlShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[postSiteStationAssignedGuards] shifts query failed', (err && (err as any).message) || err);
      shiftRows = [];
    }

    // Also include guardShift records that reference this station/postSite
    // Guard shifts: apply station OR postSite filter similarly
    const guardStationFilter = stationId ? `AND (gs.stationNameId = :stationId OR bi.id = :stationId)` : '';
    const guardPostSiteFilter = (!stationId && postSiteId) ? `AND (bi.postSiteId = :postSiteId OR gs.postSiteId = :postSiteId OR gs.post_site_id = :postSiteId)` : '';

    const sqlGuardShifts = `
      SELECT
        gs.id as id,
        gs.punchInTime,
        gs.punchOutTime,
        gs.shiftSchedule,
        gs.stationNameId as stationId,
        bi.stationName as stationName,
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
      WHERE gs.tenantId = :tenantId
        ${guardStationFilter}
        ${guardPostSiteFilter}
      ORDER BY gs.createdAt DESC
    `;

    let guardShiftRows: any[] = [];
    try {
      console.debug('[postSiteStationAssignedGuards] running guardShifts query', { tenantId, postSiteId, stationId });
      guardShiftRows = await req.database.sequelize.query(sqlGuardShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
    } catch (err) {
      console.error('[postSiteStationAssignedGuards] guardShifts query failed', (err && (err as any).message) || err);
      guardShiftRows = [];
    }

    const combined = [
      ...(shiftRows || []),
      ...(guardShiftRows || []),
    ];

    console.debug(`[postSiteStationAssignedGuards] found ${combined.length} rows for postSite ${postSiteId} station ${stationId}`);

    // Normalize combined rows into a consistent guard object
    const normalizedMap = new Map();
    for (const r of combined) {
      try {
        const guardUserId = r.guardUserId || r.userId || r.guardId || null;
        const securityGuardRecordId = r.securityGuardRecordId || r.securityGuardId || null;
        const primaryId = guardUserId || securityGuardRecordId || (r.id ? String(r.id) : null);
        if (!primaryId) continue;

        const fullName = r.fullName || r.displayName || ((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.name || r.username || r.email || null;

        const stationIdRow = r.stationId || r.station_id || null;
        const stationName = r.stationName || r.station_name || null;
        const postSiteIdRow = r.postSiteId || r.post_site_id || null;
        const securityGuardStatus = r.securityGuardStatus || r.security_guard_status || r.isOnDuty || r.is_on_duty || null;
        const userStatus = r.userStatus || r.user_status || r.active || null;

        const key = String(primaryId);
        if (!normalizedMap.has(key)) {
          normalizedMap.set(key, {
            id: key,
            guardUserId: guardUserId || null,
            securityGuardRecordId: securityGuardRecordId || null,
            fullName,
            stationId: stationIdRow ? String(stationIdRow) : null,
            stationName: stationName || null,
            postSiteId: postSiteIdRow ? String(postSiteIdRow) : null,
            securityGuardStatus: securityGuardStatus || null,
            userStatus: userStatus || null,
            source: r.source || 'shift',
            raw: r,
          });
        } else {
          const existing = normalizedMap.get(key);
          if ((!existing.stationId || existing.stationId === null) && stationIdRow) {
            existing.stationId = stationIdRow ? String(stationIdRow) : existing.stationId;
            existing.stationName = stationName || existing.stationName;
            existing.postSiteId = postSiteIdRow ? String(postSiteIdRow) : existing.postSiteId;
            normalizedMap.set(key, existing);
          }
        }
      } catch (e) {
        console.warn('[postSiteStationAssignedGuards] failed to normalize row', e && (e as any).message);
      }
    }

    let normalized = Array.from(normalizedMap.values());

    // Apply active-only filter when requested (?activeOnly=1 or true)
    try {
      const activeOnly = String(req.query.activeOnly || '').toLowerCase();
      if (activeOnly === '1' || activeOnly === 'true') {
        // Only apply active filter when we have status-like fields available in the normalized rows
        const hasStatusField = normalized.some((g: any) => g.userStatus || g.securityGuardStatus || (g.raw && (g.raw.isOnDuty || g.raw.is_on_duty || g.raw.active)));
        if (hasStatusField) {
          normalized = normalized.filter((g: any) => {
            const us = ((g.userStatus || g.securityGuardStatus || (g.raw && (g.raw.isOnDuty || g.raw.is_on_duty || g.raw.active))) || '').toString().toLowerCase();
            return us === 'active' || us === 'enabled' || us === '1' || us === 'true' || us === 'yes' || us === 'y' || us === 'true';
          });
        }
      }
    } catch (err) {
      // ignore filtering errors
    }

    await ApiResponseHandler.success(req, res, { rows: normalized, count: normalized.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
