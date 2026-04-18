import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
/** @openapi { "summary": "Create invoice", "description": "Creates a new invoice for a client.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "clientId": { "type": "string" }, "postSiteId": { "type": "string" }, "invoiceNumber": { "type": "string" }, "date": { "type": "string", "format": "date" }, "dueDate": { "type": "string", "format": "date" }, "items": { "type": "array", "items": { "type": "object", "properties": { "description": { "type": "string" }, "quantity": { "type": "number" }, "rate": { "type": "number" }, "taxRate": { "type": "number" } } } }, "notes": { "type": "string" }, "subtotal": { "type": "number" }, "total": { "type": "number" }, "importHash": { "type": "string" } }, "required": ["clientId"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */
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
