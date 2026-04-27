/**
 * @openapi {
 *  "summary": "Find business info",
 *  "description": "Retrieve a business info (post site) by id. Requires authentication.",
 *  "responses": { "200": { "description": "Business info object" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    // Debug: log caller and id to help diagnose unexpected 404s
    try {
      // eslint-disable-next-line no-console
      console.debug('[businessInfoFind] incoming request id=', req.params.id, 'headers.x-tenant-id=', req.headers['x-tenant-id'] || req.headers['x-tenantid'] || null, 'userId=', (req as any).currentUser?.id ?? null, 'currentTenant=', (req as any).currentTenant?.id ?? null, 'bypassBefore=', (req as any).bypassPermissionValidation ?? false);
      // eslint-disable-next-line no-console
      console.debug('[businessInfoFind] currentUser (preview)=', JSON.stringify((req as any).currentUser ? { id: (req as any).currentUser.id, tenants: (req as any).currentUser.tenants ? (req as any).currentUser.tenants.map((t) => (t && (t.tenantId || (t.tenant && t.tenant.id))) ) : undefined } : null));
    } catch (e) {}

    // We've already validated the caller has the `businessInfoRead` permission.
    // Mark the request to bypass the assigned-post-sites ACL so users with
    // the read permission can fetch any post-site (legacy frontends rely on this).
    (req as any).bypassPermissionValidation = true;

    // Debug: confirm bypass set
    try {
      // eslint-disable-next-line no-console
      console.debug('[businessInfoFind] bypass set=', (req as any).bypassPermissionValidation);
    } catch (e) {}

    // Attempt to fetch the record and log detailed context on failure
    let payload;
    try {
      payload = await new BusinessInfoService(req).findById(req.params.id);
    } catch (err) {
      try {
        const errAny: any = err;
        // eslint-disable-next-line no-console
        console.error('[businessInfoFind] findById failed for id=', req.params.id, 'tenant=', (req as any).currentTenant?.id ?? null, 'user=', (req as any).currentUser?.id ?? null, 'error=', errAny && errAny.message ? errAny.message : errAny);
        // eslint-disable-next-line no-console
        console.error('[businessInfoFind] full error stack:', errAny && errAny.stack ? errAny.stack : errAny);
      } catch (ee) {}
      throw err;
    }

    // Validate that customer can only access their own postSites
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
            const clientAccount = await req.database.clientAccount.findOne({
              where: {
                userId: currentUser.id,
                tenantId: currentTenant.id,
              },
              attributes: ['id'],
            });

            const postSiteClientId = payload.clientAccountId || (payload.clientAccount && payload.clientAccount.id);
            
            if (!clientAccount || !clientAccount.id || postSiteClientId !== clientAccount.id) {
              console.log('[businessInfoFind] Customer attempted to access postSite for different client');
              throw new Error403(req.language);
            }
          } catch (err) {
            if (err instanceof Error403) throw err;
            console.error('[businessInfoFind] Error validating customer access:', err);
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
