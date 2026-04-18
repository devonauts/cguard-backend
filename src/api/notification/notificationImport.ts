/** @openapi { "summary": "Import notifications (bulk)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string" }, "body": { "type": "string" }, "targetType": { "type": "string" }, "targetId": { "type": "string" }, "deviceId": { "type": "array", "items": { "type": "string" } }, "deliveryStatus": { "type": "string" }, "readStatus": { "type": "boolean" } } } }, "importHash": { "type": "string" } }, "required": ["importHash"] } } } }, "responses": { "200": { "description": "Import accepted" }, "400": { "description": "Import error or duplicate" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NotificationService from '../../services/notificationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.notificationImport,
    );

    await new NotificationService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
