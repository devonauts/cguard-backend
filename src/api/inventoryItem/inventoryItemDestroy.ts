/** @openapi { "summary": "Delete global inventory item(s)", "description": "Deletes one or more items from the global inventory catalog.", "tags": ["GlobalInventory"], "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } } } } } }, "responses": { "200": { "description": "Deleted successfully" }, "403": { "description": "Forbidden" }, "404": { "description": "Not found" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemDestroy);
    const ids = req.body?.ids || (req.query?.ids ? (Array.isArray(req.query.ids) ? req.query.ids : [req.query.ids]) : [req.params.id]).filter(Boolean);
    await new InventoryItemService(req).destroyAll(ids);
    await ApiResponseHandler.success(req, res, null);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
