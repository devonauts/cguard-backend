/**
 * @openapi {
 *  "summary": "List business info",
 *  "description": "List business infos (post sites) with pagination and filters. Requires authentication.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    // Auto-filter by clientAccount for customer role
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
              // Apply clientAccountId filter
              query = {
                ...query,
                filter: {
                  ...(query.filter || {}),
                  clientAccountId: clientAccount.id,
                },
              };
              console.log(`[businessInfoList] Auto-filtering for customer - clientAccountId: ${clientAccount.id}`);
            } else {
              // Customer has no associated clientAccount - return empty result
              console.log('[businessInfoList] Customer has no associated clientAccount - returning empty result');
              await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
              return;
            }
          } catch (err) {
            console.error('[businessInfoList] Error finding clientAccount for customer:', err);
            await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
            return;
          }
        }
      }
    }

    const payload = await new BusinessInfoService(
      req,
    ).findAndCountAll(query);

    // Attach legacy aliases the frontend list mapping reads. The repository's
    // _fillForList already attached the batched `clientAccount` ({id,name,
    // lastName,email}) and `clientAccountName`; here we add the remaining
    // legacy keys (`name`, `clientId`, `client`, lat/long/phone/email aliases)
    // without re-querying per row.
    try {
      if (payload && Array.isArray(payload.rows) && payload.rows.length) {
        payload.rows = payload.rows.map((r) => {
          const client = r.clientAccount || null;
          // legacy compatibility: frontend originally expects `name`, `clientId`, and `client` object
          const legacyClient = client
            ? {
                id: client.id,
                name: client.name || null,
                lastName: client.lastName || null,
                email: client.email || null,
              }
            : null;

          return {
            ...r,
            // legacy keys
            name: r.companyName,
            clientId: r.clientAccountId,
            client: legacyClient,
            // common aliases expected by older frontend
            latitude: r.latitud || r.latitude || null,
            longitude: r.longitud || r.longitude || null,
            phone: r.contactPhone || r.phone || null,
            email: r.contactEmail || r.email || null,
          };
        });
      }
    } catch (e) {
      console.error('Error augmenting businessInfoList payload:', e);
    }

    // Temporary debug: log payload size to help diagnose frontend empty list issue
    try {
      const debugCount = payload && payload.count ? payload.count : (payload && Array.isArray(payload.rows) ? payload.rows.length : 0);
      console.debug(`[businessInfoList] tenant=${req.params.tenantId} rows=${debugCount} sample=${payload && payload.rows && payload.rows[0] ? payload.rows[0].id : 'no-row'}`);
    } catch (e) {
      console.debug('[businessInfoList] debug log failed', e);
    }

    // Prevent browser/proxy caching of this API response which can produce
    // 304 Not Modified responses and cause the frontend to receive no body.
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } catch (e) {
      // ignore header-setting errors
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
