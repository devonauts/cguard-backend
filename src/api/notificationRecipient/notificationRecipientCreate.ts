/** @openapi { "summary": "Create notification recipient", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "notificationId": { "type": "string" }, "recipientId": { "type": "string" }, "readStatus": { "type": "boolean" }, "deliveryStatus": { "type": "string", "enum": ["Pending","Delivered","Failed"] }, "dateDelivered": { "type": "string", "format": "date-time" }, "importHash": { "type": "string" } }, "required": ["notificationId","recipientId"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NotificationRecipientService from '../../services/notificationRecipientService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.notificationRecipientCreate,
    );

    const payload = await new NotificationRecipientService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
