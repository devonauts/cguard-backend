/** @openapi { "summary": "Update business info", "description": "Update a post site (business info).", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "companyName": { "type": "string" }, "description": { "type": "string" }, "contactPhone": { "type": "string" }, "contactEmail": { "type": "string", "format": "email" }, "address": { "type": "string" }, "latitud": { "type": "number" }, "longitud": { "type": "number" }, "categoryIds": { "type": "array", "items": { "type": "string" } }, "active": { "type": "boolean" }, "importHash": { "type": "string" }, "logo": { "type": "string" }, "clientAccountId": { "type": "string" }, "secondAddress": { "type": "string" }, "country": { "type": "string" }, "city": { "type": "string" }, "postalCode": { "type": "string" } } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoEdit,
    );

    const input = req.body.data || req.body || {};

    const payload = await new BusinessInfoService(req).update(
      req.params.id,
      input,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
