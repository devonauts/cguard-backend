/** @openapi { "summary": "Update inventory history record", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "inventoryId": { "type": "string" }, "productId": { "type": "string" }, "type": { "type": "string" }, "quantity": { "type": "number" }, "date": { "type": "string", "format": "date-time" }, "note": { "type": "string" }, "metadata": { "type": "object" } } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryHistoryService from '../../services/inventoryHistoryService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryHistoryEdit,
    );

    const payload = await new InventoryHistoryService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
