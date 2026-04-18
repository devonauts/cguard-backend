/** @openapi { "summary": "Import inventory history records", "description": "Import multiple inventory movements via JSON array.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "inventoryId": { "type": "string" }, "productId": { "type": "string" }, "type": { "type": "string" }, "quantity": { "type": "number" }, "date": { "type": "string", "format": "date-time" } } } }, "importHash": { "type": "string" } } } } } }, "responses": { "200": { "description": "Import result" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryHistoryService from '../../services/inventoryHistoryService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryHistoryImport,
    );

    await new InventoryHistoryService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
