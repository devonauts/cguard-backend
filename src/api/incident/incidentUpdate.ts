/** @openapi { "summary": "Update an incident", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "date": { "type": "string", "format": "date-time" }, "dateTime": { "type": "string", "format": "date-time" }, "incidentAt": { "type": "string", "format": "date-time" }, "title": { "type": "string" }, "subject": { "type": "string" }, "description": { "type": "string" }, "content": { "type": "string" }, "action": { "type": "string" }, "postSiteId": { "type": "string" }, "callerName": { "type": "string" }, "callerType": { "type": "string" }, "status": { "type": "string" }, "priority": { "type": "string" }, "internalNotes": { "type": "string" }, "actionsTaken": { "type": "string" }, "location": { "type": "string" }, "comments": { "type": "string" }, "wasRead": { "type": "boolean" }, "stationIncidents": { "type": "string" }, "stationId": { "type": "string" }, "incidentType": { "type": "string" }, "siteId": { "type": "string" }, "clientId": { "type": "string" }, "guardNameId": { "type": "string" }, "imageUrl": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" }, "fileToken": { "type": "string" } } } }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated incident" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentService from '../../services/incidentService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.incidentEdit,
    );

    const payload = await new IncidentService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
