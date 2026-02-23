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

    const sql = `
      SELECT
        tups.id,
        tups.tenantUserId,
        tups.businessInfoId,
        tups.security_guard_id as securityGuardId,
        tups.site_tours as siteTours,
        tups.tasks as tasks,
        tups.post_orders as postOrders,
        tups.checklists as checklists,
        tups.skill_set as skillSet,
        tups.department as department,
        tups.createdAt,
        tups.updatedAt,
        tups.deletedAt,
        tu.userId as tenantUserUserId,
        u.id as userId,
        u.firstName,
        u.lastName,
        u.email,
        u.phoneNumber,
        sg.guardId as guardUserId,
        gu.id as guardUserRecordId,
        gu.firstName as guardFirstName,
        gu.lastName as guardLastName,
        gu.email as guardEmail,
        bi.companyName as postSiteName,
        ca.name as clientName,
        CONCAT_WS(' ', ca.name, ca.lastName) as clientFullName
      FROM tenant_user_post_sites tups
      LEFT JOIN businessInfos bi ON bi.id = tups.businessInfoId
      LEFT JOIN clientAccounts ca ON ca.id = bi.clientAccountId
      LEFT JOIN tenantUsers tu ON tu.id = tups.tenantUserId
      LEFT JOIN users u ON u.id = tu.userId
      LEFT JOIN securityguards sg ON sg.id = tups.security_guard_id
      LEFT JOIN users gu ON gu.id = sg.guardId
      WHERE (tups.security_guard_id = :resolvedSecurityGuardId OR tu.userId = :guardUserId)
        AND (tu.tenantId = :tenantId OR tu.tenantId IS NULL)
      ORDER BY tups.createdAt DESC
    `;

    const rows: any[] = await req.database.sequelize.query(sql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

    await ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
