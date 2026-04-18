/** @openapi { "summary": "Import certifications", "description": "Import multiple certification records.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string" }, "code": { "type": "string" }, "description": { "type": "string" }, "acquisitionDate": { "type": "string", "format": "date-time" }, "expirationDate": { "type": "string", "format": "date-time" } } } }, "importHash": { "type": "string" } } } } }, "responses": { "200": { "description": "Import result" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CertificationService from '../../services/certificationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.certificationImport,
    );

    await new CertificationService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
