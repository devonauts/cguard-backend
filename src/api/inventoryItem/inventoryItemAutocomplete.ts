/** @openapi { "summary": "Autocomplete global inventory items", "description": "Returns matching items for autocomplete/typeahead fields.", "tags": ["GlobalInventory"], "parameters": [ { "name": "query", "in": "query", "schema": { "type": "string" }, "description": "Search text" }, { "name": "limit", "in": "query", "schema": { "type": "integer" }, "description": "Max results" } ], "responses": { "200": { "description": "Array of {id, label} matches" }, "403": { "description": "Forbidden" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemRead);
    const payload = await new InventoryItemService(req).findAllAutocomplete(
      req.query.query,
      req.query.limit,
    );
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
