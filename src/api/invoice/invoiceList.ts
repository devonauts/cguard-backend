/**
 * @openapi {
 *  "summary": "List invoices",
 *  "description": "List invoices with filters and pagination.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceRead,
    );

    // Auto-filter by clientAccount userId for customer role
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
              // Apply clientId filter
              query = {
                ...query,
                filter: {
                  ...(query.filter || {}),
                  clientId: clientAccount.id,
                },
              };
              console.log(`[invoiceList] Auto-filtering for customer - clientId: ${clientAccount.id}`);
            } else {
              // Customer has no associated clientAccount - return empty result
              console.log('[invoiceList] Customer has no associated clientAccount - returning empty result');
              await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
              return;
            }
          } catch (err) {
            console.error('[invoiceList] Error finding clientAccount for customer:', err);
            await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
            return;
          }
        }
      }
    }

    const payload = await new InvoiceService(
      req,
    ).findAndCountAll(query);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
