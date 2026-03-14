import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;

    const replacements = { tenantId, postSiteId };

    // Join tenant_user_post_sites -> tenantUsers -> users -> securityGuards
    // Match guards by EITHER security_guard_id FK OR by userId (same logic as securityGuardAssignments)
    const sql = `
      SELECT
        tups.id as id,
        tups.tenantUserId as tenantUserId,
        tups.businessInfoId as businessInfoId,
        tups.security_guard_id as securityGuardRecordId,
        tups.site_tours as siteTours,
        tups.tasks as tasks,
        tups.post_orders as postOrders,
        tups.checklists as checklists,
        tups.skill_set as skillSet,
        tups.department as department,
        tu.status as tenantUserStatus,
        u.id as userId,
        u.firstName as firstName,
        u.lastName as lastName,
        u.email as email,
        u.phoneNumber as phoneNumber,
        sg.id as securityGuardId,
        sg.guardId as guardUserId
      FROM tenant_user_post_sites tups
      LEFT JOIN tenantUsers tu ON tu.id = tups.tenantUserId
      LEFT JOIN users u ON u.id = tu.userId
      LEFT JOIN securityGuards sg ON (sg.id = tups.security_guard_id OR sg.guardId = u.id) AND sg.tenantId = :tenantId
      WHERE tups.businessInfoId = :postSiteId
        AND (tu.tenantId = :tenantId OR tu.tenantId IS NULL)
        AND (tu.status IS NULL OR tu.status <> 'pending')
        AND u.id IS NOT NULL
        AND sg.id IS NOT NULL
      ORDER BY u.firstName, u.lastName;
    `;

    // sequelize.query with QueryTypes.SELECT returns an array of rows.
    const results: any[] = await req.database.sequelize.query(sql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

    // Also include assignments that come from shifts linked to this post site (station)
    const sqlShifts = `
      SELECT
        s.id as id,
        s.startTime,
        s.endTime,
        s.stationId as businessInfoId,
        bi.companyName as postSiteName,
        ca.name as clientName,
        s.guardId as guardUserId,
        u.firstName as firstName,
        u.lastName as lastName,
        u.email as email,
        u.phoneNumber as phoneNumber,
        'shift' as source,
        s.createdAt,
        s.updatedAt
      FROM shifts s
      LEFT JOIN businessInfos bi ON bi.id = s.stationId
      LEFT JOIN clientAccounts ca ON ca.id = bi.clientAccountId
      LEFT JOIN users u ON u.id = s.guardId
      WHERE s.stationId = :postSiteId
        AND s.tenantId = :tenantId
      ORDER BY s.createdAt DESC
    `;

    const shiftRows: any[] = await req.database.sequelize.query(sqlShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

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
        sg.guardId as guardUserId,
        gu.firstName as firstName,
        gu.lastName as lastName,
        gu.email as email,
        gu.phoneNumber as phoneNumber,
        'guardShift' as source,
        gs.createdAt,
        gs.updatedAt
      FROM guardShifts gs
      LEFT JOIN businessInfos bi ON bi.id = gs.stationNameId
      LEFT JOIN clientAccounts ca ON ca.id = bi.clientAccountId
      LEFT JOIN securityGuards sg ON sg.id = gs.guardNameId
      LEFT JOIN users gu ON gu.id = sg.guardId
      WHERE gs.stationNameId = :postSiteId
        AND gs.tenantId = :tenantId
      ORDER BY gs.createdAt DESC
    `;

    const guardShiftRows: any[] = await req.database.sequelize.query(sqlGuardShifts, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

    const combined = [
      ...(results || []),
      ...(shiftRows || []),
      ...(guardShiftRows || []),
    ];

    console.debug(`[postSiteAssignedGuards] found ${combined.length} combined rows for postSite ${postSiteId}`);

    // Return merged rows including `source` to let frontend distinguish origin.
    await ApiResponseHandler.success(req, res, { rows: combined, count: combined.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
