/** @openapi { "summary": "Update a patrol log entry", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "patrol": { "type": "string" }, "scanTime": { "type": "string", "format": "date-time" }, "latitude": { "type": "string" }, "longitude": { "type": "string" }, "validLocation": { "type": "boolean" }, "scannedBy": { "type": "string" }, "status": { "type": "string" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated patrol log" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PatrolLogService from '../../services/patrolLogService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.patrolLogEdit,
    );

    const payload = await new PatrolLogService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
