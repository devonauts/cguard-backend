/**
 * @openapi {
 *  "summary": "Find guard",
 *  "description": "Retrieve a security guard by id. Requires authentication.",
 *  "responses": { "200": { "description": "Security guard object" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const payload = await new SecurityGuardService(req).findById(
      req.params.id,
    );

    // Validate that customer can only access guards assigned to their postSites
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

              if (postSiteIds.length > 0) {
                // Check if this guard is assigned to any of the customer's postSites
                const guardUserId = payload.guardId || (payload.guard && payload.guard.id);
                
                if (guardUserId) {
                  // Find tenantUser for this guard
                  const tenantUser = await req.database.tenantUser.findOne({
                    where: {
                      userId: guardUserId,
                      tenantId: currentTenant.id,
                    },
                    attributes: ['id'],
                  });

                  if (tenantUser && tenantUser.id) {
                    // Check if there's a shift for this guard in any of the customer's postSites
                    const shift = await req.database.shift.findOne({
                      where: {
                        tenantUserId: tenantUser.id,
                        postSite: postSiteIds,
                        tenantId: currentTenant.id,
                      },
                    });

                    if (!shift) {
                      console.log('[securityGuardFind] Customer attempted to access guard not assigned to their postSites');
                      throw new Error403(req.language);
                    }
                  } else {
                    console.log('[securityGuardFind] Customer attempted to access guard with no tenantUser');
                    throw new Error403(req.language);
                  }
                } else {
                  console.log('[securityGuardFind] Customer attempted to access guard with no guardId');
                  throw new Error403(req.language);
                }
              } else {
                // Customer has no postSites
                console.log('[securityGuardFind] Customer has no postSites');
                throw new Error403(req.language);
              }
            } else {
              // Customer has no clientAccount
              console.log('[securityGuardFind] Customer has no clientAccount');
              throw new Error403(req.language);
            }
          } catch (err) {
            if (err instanceof Error403) throw err;
            console.error('[securityGuardFind] Error validating customer access:', err);
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
