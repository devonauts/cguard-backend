import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    // Allow users with userRead permission (post-site admin) to view assignments
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    const incomingId = req.params.id;

    // Try to resolve incoming id as securityGuard.id or securityGuard.guardId (user id)
    let resolvedSecurityGuardId = null;
    let guardUserId = null;
    try {
      const byId = await req.database.securityGuard.findOne({ where: { id: incomingId, tenantId } });
      if (byId && byId.id) {
        resolvedSecurityGuardId = byId.id;
        guardUserId = byId.guardId || null;
      } else {
        const byGuard = await req.database.securityGuard.findOne({ where: { guardId: incomingId, tenantId } });
        if (byGuard && byGuard.id) {
          resolvedSecurityGuardId = byGuard.id;
          guardUserId = byGuard.guardId || null;
        } else {
          // incomingId might be a user id directly
          guardUserId = incomingId;
        }
      }
    } catch (e: any) {
      console.warn('securityGuardAssignments: failed to resolve security guard', e && e.message ? e.message : e);
      guardUserId = incomingId;
    }

    const replacements = { tenantId, resolvedSecurityGuardId, guardUserId };

    // No longer reading assignments from tenant_user_post_sites pivot.
    // Use `shifts` and `guardShifts` as canonical sources for guard assignments.

    // Also include assignments coming from shifts (user-level shifts)
    const sqlShifts = `
      SELECT
        s.id,
        s.startTime,
        s.endTime,
        COALESCE(st.postSiteId, s.stationId, st.id) as businessInfoId,
        COALESCE(bi.companyName, st.stationName) as postSiteName,
        st.stationName as stationName,
        COALESCE(ca_bi.name, ca_st.name) as clientName,
        s.guardId as guardUserId,
        u.firstName,
        u.lastName,
        'shift' as source,
        s.createdAt,
        s.updatedAt
      FROM shifts s
      LEFT JOIN stations st ON st.id = s.stationId
      LEFT JOIN businessInfos bi ON bi.id = st.postSiteId
      LEFT JOIN clientAccounts ca_bi ON ca_bi.id = bi.clientAccountId
      LEFT JOIN clientAccounts ca_st ON ca_st.id = st.stationOriginId
      LEFT JOIN users u ON u.id = s.guardId
      WHERE s.guardId = :guardUserId
        AND s.tenantId = :tenantId
      ORDER BY s.createdAt DESC
    `;

    const shiftRows: any[] = guardUserId
      ? await req.database.sequelize.query(sqlShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT })
      : [];

    // Include guardShift records (these reference securityGuard entries and may map to user via securityGuards.guardId)
    const sqlGuardShifts = `
      SELECT
        gs.id,
        gs.punchInTime,
        gs.punchOutTime,
        gs.shiftSchedule,
        COALESCE(st.postSiteId, gs.stationNameId, st.id) as businessInfoId,
        COALESCE(bi.companyName, st.stationName) as postSiteName,
        st.stationName as stationName,
        COALESCE(ca_bi.name, ca_st.name) as clientName,
        gs.guardNameId as securityGuardId,
        sg.guardId as guardUserId,
        gu.firstName as guardFirstName,
        gu.lastName as guardLastName,
        'guardShift' as source,
        gs.createdAt,
        gs.updatedAt
      FROM guardShifts gs
      LEFT JOIN stations st ON st.id = gs.stationNameId
      LEFT JOIN businessInfos bi ON bi.id = st.postSiteId
      LEFT JOIN clientAccounts ca_bi ON ca_bi.id = bi.clientAccountId
      LEFT JOIN clientAccounts ca_st ON ca_st.id = st.stationOriginId
      LEFT JOIN securityGuards sg ON sg.id = gs.guardNameId
      LEFT JOIN users gu ON gu.id = sg.guardId
      WHERE (gs.guardNameId = :resolvedSecurityGuardId OR sg.guardId = :guardUserId)
        AND gs.tenantId = :tenantId
      ORDER BY gs.createdAt DESC
    `;

    const guardShiftRows: any[] = await req.database.sequelize.query(sqlGuardShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

    const combined = [
      ...shiftRows,
      ...guardShiftRows,
    ];

    await ApiResponseHandler.success(req, res, { rows: combined, count: combined.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
