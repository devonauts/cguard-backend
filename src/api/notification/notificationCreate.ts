/** @openapi { "summary": "Create notification", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "title": { "type": "string" }, "body": { "type": "string" }, "targetType": { "type": "string", "enum": ["All","Client","User"] }, "targetId": { "type": "string" }, "deviceId": { "type": "array", "items": { "type": "string" } }, "imageUrl": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" } } } }, "deliveryStatus": { "type": "string", "enum": ["Pending","Delivered","Failed"] }, "readStatus": { "type": "boolean" }, "importHash": { "type": "string" } }, "required": ["title","body"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NotificationService from '../../services/notificationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.notificationCreate,
    );

    const payload = await new NotificationService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
