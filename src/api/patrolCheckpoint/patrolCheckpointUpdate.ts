/** @openapi { "summary": "Update a patrol checkpoint", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "latitud": { "type": "string" }, "longitud": { "type": "string" }, "station": { "type": "string" }, "patrols": { "type": "array", "items": { "type": "string" } }, "assignedQrImage": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" } } } }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated checkpoint" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PatrolCheckpointService from '../../services/patrolCheckpointService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.patrolCheckpointEdit,
    );

    const payload = await new PatrolCheckpointService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
