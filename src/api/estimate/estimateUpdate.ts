/** @openapi { "summary": "Update an estimate", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "clientId": { "type": "string" }, "postSiteId": { "type": "string" }, "estimateNumber": { "type": "string" }, "date": { "type": "string", "format": "date" }, "dueDate": { "type": "string", "format": "date" }, "items": { "type": "array", "items": { "type": "object", "properties": { "description": { "type": "string" }, "quantity": { "type": "number" }, "unitPrice": { "type": "number" }, "total": { "type": "number" } } } }, "notes": { "type": "string" }, "subtotal": { "type": "number" }, "total": { "type": "number" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Estimate updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import EstimateService from '../../services/estimateService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateEdit,
    );

    const payload = await new EstimateService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
