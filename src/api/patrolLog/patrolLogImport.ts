/** @openapi { "summary": "Import patrol logs (CSV/JSON)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "object" }, "importHash": { "type": "string" } }, "required": ["importHash"] } } } }, "responses": { "200": { "description": "Import accepted" }, "400": { "description": "Import error or duplicate" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PatrolLogService from '../../services/patrolLogService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.patrolLogImport,
    );

    await new PatrolLogService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
