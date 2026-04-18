/** @openapi { "summary": "Update notification recipient", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "recipientId": { "type": "string" }, "readStatus": { "type": "boolean" }, "deliveryStatus": { "type": "string", "enum": ["Pending","Delivered","Failed"] }, "dateDelivered": { "type": "string", "format": "date-time" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NotificationRecipientService from '../../services/notificationRecipientService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.notificationRecipientEdit,
    );

    const payload = await new NotificationRecipientService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
