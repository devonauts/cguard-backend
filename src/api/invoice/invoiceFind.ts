/**
 * @openapi {
 *  "summary": "Find invoice",
 *  "description": "Retrieve an invoice by id.",
 *  "responses": { "200": { "description": "Invoice object" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceRead,
    );

    const payload = await new InvoiceService(req).findById(
      req.params.id,
    );

    // Validate that customer can only access their own invoices
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
          // Find the clientAccount associated with this user
          try {
            const clientAccount = await req.database.clientAccount.findOne({
              where: {
                userId: currentUser.id,
                tenantId: currentTenant.id,
              },
              attributes: ['id'],
            });

            const invoiceClientId = payload.clientId || (payload.client && payload.client.id);
            
            if (!clientAccount || !clientAccount.id || invoiceClientId !== clientAccount.id) {
              console.log(`[invoiceFind] Customer attempted to access invoice for different client`);
              throw new Error403(req.language);
            }
          } catch (err) {
            if (err instanceof Error403) throw err;
            console.error('[invoiceFind] Error validating customer access:', err);
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
