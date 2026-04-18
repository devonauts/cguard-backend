/** @openapi { "summary": "Update a patrol", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "scheduledTime": { "type": "string", "format": "date-time" }, "completed": { "type": "boolean" }, "completionTime": { "type": "string", "format": "date-time" }, "status": { "type": "string" }, "assignedGuard": { "type": "string" }, "supervisorId": { "type": "string" }, "station": { "type": "string" }, "checkpoints": { "type": "array", "items": { "type": "string" } }, "logs": { "type": "array", "items": { "type": "string" } } }, "required": [] } } } }, "responses": { "200": { "description": "Updated patrol object" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PatrolService from '../../services/patrolService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.patrolEdit,
    );

    const payload = await new PatrolService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
