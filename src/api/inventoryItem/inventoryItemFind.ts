/** @openapi { "summary": "Find global inventory item by ID", "description": "Returns a single item from the global inventory catalog.", "tags": ["GlobalInventory"], "responses": { "200": { "description": "Inventory item details" }, "403": { "description": "Forbidden" }, "404": { "description": "Not found" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemRead);
    const payload = await new InventoryItemService(req).findById(req.params.id);
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
