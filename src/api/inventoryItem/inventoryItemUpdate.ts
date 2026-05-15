/** @openapi { "summary": "Update global inventory item", "description": "Updates an existing item in the global inventory catalog.", "tags": ["GlobalInventory"], "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "type": { "type": "string", "enum": ["radio","arma","chaleco_antibalas","tolete","pito","linterna","bitacora","cinto_completo","poncho_de_aguas","detector_de_metales","caseta","vehiculo","otro"] }, "brand": { "type": "string" }, "modelName": { "type": "string" }, "serialNumber": { "type": "string" }, "condition": { "type": "string", "enum": ["bueno","regular","dañado"] }, "status": { "type": "string", "enum": ["disponible","asignado","en_mantenimiento","retirado"] }, "notes": { "type": "string" }, "expirationDate": { "type": "string", "format": "date" } } } } } }, "responses": { "200": { "description": "Updated item" }, "400": { "description": "Validation error" }, "403": { "description": "Forbidden" }, "404": { "description": "Not found" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemEdit);
    const payload = await new InventoryItemService(req).update(
      req.params.id,
      req.body.data || req.body,
    );
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
