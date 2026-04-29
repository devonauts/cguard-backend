/**
 * @openapi {
 *  "summary": "List guards",
 *  "description": "List security guards with pagination and filters. Requires authentication.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    // Normalize query args: build { filter, limit, offset, orderBy }
    const raw = req.query || {};

    let args: any = {};

    // If frontend already sent a nested filter object, use it
    if (raw.filter && typeof raw.filter === 'object') {
      args.filter = raw.filter;
    } else {
      args.filter = {};
      // Support keys like filter[archived]=true or filter.status=active
      for (const key of Object.keys(raw)) {
        if (key.startsWith('filter[')) {
          // e.g. filter[archived]
          const inner = key.replace(/^filter\[(.*)\]$/, '$1');
          args.filter[inner] = raw[key];
        } else if (key.startsWith('filter.')) {
          const inner = key.replace(/^filter\.(.*)$/, '$1');
          args.filter[inner] = raw[key];
        }
      }
    }

    // Also copy pagination/order params if present
    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    // Default: include archived (soft-deleted) records so frontend can show
    // all guards with their respective statuses unless caller explicitly
    // requests otherwise.
    if (!Object.prototype.hasOwnProperty.call(args, 'filter') || typeof args.filter !== 'object') {
      args.filter = args.filter || {};
    }
    if (!Object.prototype.hasOwnProperty.call(args.filter, 'includeDeleted') && !Object.prototype.hasOwnProperty.call(args.filter, 'archived')) {
      args.filter.includeDeleted = true;
    }

    // Auto-filter by assigned postSites for customer role
    const currentUser = req.currentUser;
    const currentTenant = req.currentTenant;

    if (currentUser && currentTenant) {
      const tenantForUser = (currentUser.tenants || [])
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant && t.tenant.id === currentTenant.id);

      if (tenantForUser) {
        const userRoles = tenantForUser.roles || [];
        const isCustomer = userRoles.includes(Roles.values.customer);

        if (isCustomer) {
          // Find the clientAccount associated with this user
          try {
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
                // Find guards assigned to these postSites via shifts table
                const shifts = await req.database.shift.findAll({
                  where: {
                    postSiteId: postSiteIds,
                    tenantId: currentTenant.id,
                  },
                  attributes: ['tenantUserId'],
                  group: ['tenantUserId'],
                });

                const tenantUserIds = (shifts || []).map((s) => s.tenantUserId).filter(Boolean);

                if (tenantUserIds.length > 0) {
                  // Get the user IDs (guardId) from tenantUser
                  const tenantUsers = await req.database.tenantUser.findAll({
                    where: {
                      id: tenantUserIds,
                      tenantId: currentTenant.id,
                    },
                    attributes: ['userId'],
                  });

                  const guardIds = (tenantUsers || []).map((tu) => tu.userId).filter(Boolean);

                  if (guardIds.length > 0) {
                    // Apply guard filter
                    args.filter = {
                      ...args.filter,
                      guard: guardIds,
                    };
                    console.log(`[securityGuardList] Auto-filtering for customer - ${guardIds.length} guards found`);
                  } else {
                    // No guards found - return empty result
                    console.log('[securityGuardList] Customer has no guards assigned to their postSites - returning empty result');
                    await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
                    return;
                  }
                } else {
                  // No shifts found - return empty result
                  console.log('[securityGuardList] Customer has no shifts for their postSites - returning empty result');
                  await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
                  return;
                }
              } else {
                // Customer has no postSites - return empty result
                console.log('[securityGuardList] Customer has no postSites - returning empty result');
                await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
                return;
              }
            } else {
              // Customer has no associated clientAccount - return empty result
              console.log('[securityGuardList] Customer has no associated clientAccount - returning empty result');
              await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
              return;
            }
          } catch (err) {
            console.error('[securityGuardList] Error filtering for customer:', err);
            await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
            return;
          }
        }
      }
    }

    const payload = await new SecurityGuardService(
      req,
    ).findAndCountAll(args);

    // Temporary debug logs to help diagnose mismatched counts
    try {
      const tenantIdDebug = req.currentTenant && req.currentTenant.id ? req.currentTenant.id : null;
      const rowsCount = payload && Array.isArray(payload.rows) ? payload.rows.length : (payload && payload.rows ? Object.keys(payload.rows).length : 0);
      const reportedCount = payload && typeof payload.count === 'number' ? payload.count : null;
      console.debug('[securityGuardList] debug:', { tenantId: tenantIdDebug, rowsCount, reportedCount, sampleRows: (payload && payload.rows ? (Array.isArray(payload.rows) ? payload.rows.slice(0,5).map(r=>({id:r.id, guardId: r.guardId || r.guard && r.guard.id, fullName: r.fullName})) : payload.rows) : null) });
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[securityGuardList] debug logging failed', msg);
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
