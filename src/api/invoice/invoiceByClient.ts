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

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceRead,
    );

    const filter = { ...(req.query && req.query.filter ? req.query.filter : {}), clientId: req.params.clientId };
    const payload = await new InvoiceService(
      req,
    ).findAndCountAll({ filter, limit: req.query.limit, offset: req.query.offset, orderBy: req.query.orderBy });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
