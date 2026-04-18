/** @openapi { "summary": "Create a memo", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "dateTime": { "type": "string", "format": "date-time" }, "subject": { "type": "string" }, "content": { "type": "string" }, "wasAccepted": { "type": "boolean" }, "guardName": { "type": "string" }, "memoDocumentPdf": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" } } } }, "importHash": { "type": "string" } }, "required": ["subject"] } } } }, "responses": { "200": { "description": "Created memo" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import MemosService from '../../services/memosService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.memosCreate,
    );

    const payload = await new MemosService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
