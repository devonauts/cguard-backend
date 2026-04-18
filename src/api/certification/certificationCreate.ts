/** @openapi { "summary": "Create certification", "description": "Create a certification record for a tenant.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "title": { "type": "string" }, "code": { "type": "string" }, "description": { "type": "string" }, "acquisitionDate": { "type": "string", "format": "date-time" }, "expirationDate": { "type": "string", "format": "date-time" }, "image": { "type": "array", "items": { "type": "object" } }, "icon": { "type": "array", "items": { "type": "object" } }, "importHash": { "type": "string" } }, "required": ["title","code","description"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CertificationService from '../../services/certificationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.certificationCreate,
    );

    const payload = await new CertificationService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
