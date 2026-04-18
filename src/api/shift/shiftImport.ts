/** @openapi { "summary": "Import shifts", "description": "Import multiple shifts via JSON array.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "postSite": { "type": "string" }, "tenantUserId": { "type": "string" }, "station": { "type": "string" }, "startAt": { "type": "string", "format": "date-time" }, "endAt": { "type": "string", "format": "date-time" } } } }, "importHash": { "type": "string" } } } } } }, "responses": { "200": { "description": "Import result" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftService from '../../services/shiftService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.shiftImport,
    );

    await new ShiftService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
