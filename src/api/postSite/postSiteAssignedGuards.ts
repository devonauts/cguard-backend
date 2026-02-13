import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userRead);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;

    const replacements = { tenantId, postSiteId };

    // Join tenant_user_post_sites -> tenantUsers -> users -> securityguards
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
      LEFT JOIN securityguards sg ON sg.id = tups.security_guard_id
      WHERE tups.businessInfoId = :postSiteId
        AND (tu.tenantId = :tenantId OR tu.tenantId IS NULL)
      ORDER BY u.firstName, u.lastName;
    `;

    // sequelize.query with QueryTypes.SELECT returns an array of rows.
    const results: any[] = await req.database.sequelize.query(sql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });

    console.debug(`[postSiteAssignedGuards] found ${Array.isArray(results) ? results.length : 0} rows for postSite ${postSiteId}`);

    // Return a consistent payload shape used by other list endpoints.
    await ApiResponseHandler.success(req, res, { rows: results || [], count: (results || []).length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
