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

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
