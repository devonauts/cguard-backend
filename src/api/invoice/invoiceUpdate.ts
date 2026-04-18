/** @openapi { "summary": "Update invoice", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "clientId": { "type": "string" }, "postSiteId": { "type": "string" }, "invoiceNumber": { "type": "string" }, "date": { "type": "string", "format": "date" }, "dueDate": { "type": "string", "format": "date" }, "items": { "type": "array", "items": { "type": "object", "properties": { "description": { "type": "string" }, "quantity": { "type": "number" }, "rate": { "type": "number" }, "taxRate": { "type": "number" } } } }, "notes": { "type": "string" }, "subtotal": { "type": "number" }, "total": { "type": "number" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceEdit,
    );

    const payload = await new InvoiceService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
