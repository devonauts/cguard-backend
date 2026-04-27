import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardShiftService from '../../services/guardShiftService';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.guardShiftRead,
    );

    // Auto-filter by postSites for customer role
    const currentUser = req.currentUser;
    const currentTenant = req.currentTenant;
    let query = { ...req.query };

    if (currentUser && currentTenant) {
      const tenantForUser = (currentUser.tenants || [])
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant && t.tenant.id === currentTenant.id);

      if (tenantForUser) {
        const userRoles = tenantForUser.roles || [];
        const isCustomer = userRoles.includes(Roles.values.customer);

        if (isCustomer) {
          try {
            // Find the clientAccount associated with this user
            const clientAccount = await req.database.clientAccount.findOne({
              where: {
                userId: currentUser.id,
                tenantId: currentTenant.id,
              },
              attributes: ['id'],
            });

            if (clientAccount && clientAccount.id) {
              // Find postSites for this client
              const postSites = await req.database.businessInfo.findAll({
                where: {
                  clientAccountId: clientAccount.id,
                  tenantId: currentTenant.id,
                },
                attributes: ['id'],
              });

              const postSiteIds = (postSites || []).map((p) => p.id).filter(Boolean);

              if (postSiteIds.length > 0) {
                // Apply postSiteId filter to guard shifts
                query = {
                  ...query,
                  filter: {
                    ...(query.filter || {}),
                    postSiteId: postSiteIds,
                  },
                };
                console.log(`[guardShiftList] Auto-filtering for customer - ${postSiteIds.length} postSites`);
              } else {
                // Customer has no postSites - return empty result
                console.log('[guardShiftList] Customer has no postSites - returning empty result');
                await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
                return;
              }
            } else {
              // Customer has no associated clientAccount - return empty result
              console.log('[guardShiftList] Customer has no associated clientAccount - returning empty result');
              await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
              return;
            }
          } catch (err) {
            console.error('[guardShiftList] Error filtering for customer:', err);
            await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
            return;
          }
        }
      }
    }

    const payload = await new GuardShiftService(
      req,
    ).findAndCountAll(query);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
