/** @openapi { "summary": "Import estimates (bulk)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "clientId": { "type": "string" }, "postSiteId": { "type": "string" }, "estimateNumber": { "type": "string" }, "date": { "type": "string", "format": "date" }, "total": { "type": "number" } } } }, "importHash": { "type": "string" } }, "required": ["importHash"] } } } }, "responses": { "200": { "description": "Import accepted" }, "400": { "description": "Import error or duplicate" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import EstimateService from '../../services/estimateService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateImport,
    );

    await new EstimateService(req).import(
      req.body.data,
      req.body.importHash,
    );

    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
