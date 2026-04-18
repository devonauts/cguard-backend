/** @openapi { "summary": "Create inventory history record", "description": "Record an inventory movement (in/out/adjustment).", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "inventoryId": { "type": "string" }, "productId": { "type": "string" }, "type": { "type": "string", "enum": ["in","out","adjustment"] }, "quantity": { "type": "number" }, "date": { "type": "string", "format": "date-time" }, "note": { "type": "string" }, "metadata": { "type": "object" } }, "required": ["inventoryId","productId","type","quantity"] } } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryHistoryService from '../../services/inventoryHistoryService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryHistoryCreate,
    );

    const payload = await new InventoryHistoryService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
