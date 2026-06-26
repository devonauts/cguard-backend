/**
 * @openapi {
 *  "summary": "List invoices by client",
 *  "description": "List invoices for a given client with filters and pagination.",
 *  "responses": { "200": { "description": "Paginated list" } }
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

    // A customer may only read invoices for their OWN client. invoiceRead
    // includes the customer role, and this endpoint trusted req.params.clientId,
    // so a customer could read any client's invoices by changing the URL id.
    let effectiveClientId = req.params.clientId;
    const currentUser = req.currentUser;
    const currentTenant = req.currentTenant;
    if (currentUser && currentTenant) {
      const tenantForUser = (currentUser.tenants || [])
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant && t.tenant.id === currentTenant.id);
      const isCustomer = !!tenantForUser && (tenantForUser.roles || []).includes(Roles.values.customer);
      if (isCustomer) {
        const clientAccount = await req.database.clientAccount.findOne({
          where: { userId: currentUser.id, tenantId: currentTenant.id },
          attributes: ['id'],
        });
        if (!clientAccount || String(clientAccount.id) !== String(req.params.clientId)) {
          throw new Error403(req.language);
        }
        effectiveClientId = clientAccount.id;
      }
    }

    const filter = { ...(req.query && req.query.filter ? req.query.filter : {}), clientId: effectiveClientId };
    const payload = await new InvoiceService(
      req,
    ).findAndCountAll({ filter, limit: req.query.limit, offset: req.query.offset, orderBy: req.query.orderBy });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
