/** @openapi { "summary": "Create global inventory item", "description": "Creates a new item in the global inventory catalog.", "tags": ["GlobalInventory"], "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "type": { "type": "string", "enum": ["radio","arma","chaleco_antibalas","tolete","pito","linterna","bitacora","cinto_completo","poncho_de_aguas","detector_de_metales","caseta","vehiculo","otro"] }, "brand": { "type": "string" }, "modelName": { "type": "string" }, "serialNumber": { "type": "string" }, "condition": { "type": "string", "enum": ["bueno","regular","dañado"] }, "status": { "type": "string", "enum": ["disponible","asignado","en_mantenimiento","retirado"] }, "notes": { "type": "string" }, "expirationDate": { "type": "string", "format": "date" }, "importHash": { "type": "string" } }, "required": ["name","type"] } } } }, "responses": { "200": { "description": "Created item" }, "400": { "description": "Validation error" }, "403": { "description": "Forbidden" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryItemService from '../../services/inventoryItemService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemCreate);
    const payload = await new InventoryItemService(req).create(req.body.data || req.body);
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
