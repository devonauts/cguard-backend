/** @openapi { "summary": "Import business infos (post-sites)", "description": "Import multiple business info records (CSV/array).", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "companyName": { "type": "string" }, "description": { "type": "string" }, "contactPhone": { "type": "string" }, "contactEmail": { "type": "string" }, "address": { "type": "string" }, "postalCode": { "type": "string" }, "city": { "type": "string" }, "country": { "type": "string" }, "clientId": { "type": "string" }, "clientAccountName": { "type": "string" }, "categoryIds": { "type": "string" }, "importHash": { "type": "string" } } } }, "importHash": { "type": "string" } } } } } }, "responses": { "200": { "description": "Import result" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoImport,
    );

    await new BusinessInfoService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
