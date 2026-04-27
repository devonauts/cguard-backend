import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardShiftService from '../../services/guardShiftService';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.guardShiftRead,
    );

    const payload = await new GuardShiftService(req).findById(
      req.params.id,
    );

    // Validate that customer can only access guard shifts from their postSites
    const currentUser = req.currentUser;
    const currentTenant = req.currentTenant;

    if (currentUser && currentTenant && payload) {
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

              // Validate that the guard shift belongs to one of the customer's postSites
              const shiftPostSiteId = payload.postSiteId;

              if (!shiftPostSiteId || !postSiteIds.includes(shiftPostSiteId)) {
                console.log('[guardShiftFind] Customer attempted to access guard shift from different postSite');
                throw new Error403(req.language);
              }
            } else {
              // Customer has no clientAccount
              console.log('[guardShiftFind] Customer has no clientAccount');
              throw new Error403(req.language);
            }
          } catch (err) {
            if (err instanceof Error403) throw err;
            console.error('[guardShiftFind] Error validating customer access:', err);
            throw new Error403(req.language);
          }
        }
      }
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
