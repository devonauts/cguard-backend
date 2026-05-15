/** @openapi { "summary": "List global inventory items", "description": "Returns a paginated list of items from the global inventory catalog.", "tags": ["GlobalInventory"], "parameters": [ { "name": "filter[name]", "in": "query", "schema": { "type": "string" } }, { "name": "filter[type]", "in": "query", "schema": { "type": "string" } }, { "name": "filter[status]", "in": "query", "schema": { "type": "string" } }, { "name": "filter[condition]", "in": "query", "schema": { "type": "string" } }, { "name": "limit", "in": "query", "schema": { "type": "integer" } }, { "name": "offset", "in": "query", "schema": { "type": "integer" } }, { "name": "orderBy", "in": "query", "schema": { "type": "string" } } ], "responses": { "200": { "description": "Paginated list of inventory items" }, "403": { "description": "Forbidden" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemRead);
    const payload = await new InventoryItemService(req).findAndCountAll(req.query);
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
