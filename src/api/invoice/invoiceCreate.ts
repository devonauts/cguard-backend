import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
/**
 * @openapi {
 *  "summary": "Create invoice",
 *  "description": "Creates a new invoice for a client.",
 *  "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } },
 *  "responses": { "200": { "description": "Created" } }
 * }
 */
import InvoiceService from '../../services/invoiceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceCreate,
    );

    const payload = await new InvoiceService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
