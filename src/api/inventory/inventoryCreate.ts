/** @openapi { "summary": "Create inventory record", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "belongsTo": { "type": "string" }, "belongsToStation": { "type": "string" }, "radio": { "type": "boolean" }, "radioType": { "type": "string" }, "radioSerialNumber": { "type": "string" }, "gun": { "type": "boolean" }, "gunType": { "type": "string" }, "gunSerialNumber": { "type": "string" }, "armor": { "type": "boolean" }, "armorType": { "type": "string" }, "armorSerialNumber": { "type": "string" }, "tolete": { "type": "boolean" }, "pito": { "type": "boolean" }, "linterna": { "type": "boolean" }, "vitacora": { "type": "boolean" }, "cintoCompleto": { "type": "boolean" }, "ponchoDeAguas": { "type": "boolean" }, "detectorDeMetales": { "type": "boolean" }, "caseta": { "type": "boolean" }, "observations": { "type": "string" }, "transportation": { "type": "string" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Created inventory object" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryService from '../../services/inventoryService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryCreate,
    );

    const payload = await new InventoryService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
