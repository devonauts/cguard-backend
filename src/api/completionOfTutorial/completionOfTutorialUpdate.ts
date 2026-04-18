/** @openapi { "summary": "Update completion of tutorial", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "completedAt": { "type": "string", "format": "date-time" }, "notes": { "type": "string" } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CompletionOfTutorialService from '../../services/completionOfTutorialService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.completionOfTutorialEdit,
    );

    const payload = await new CompletionOfTutorialService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
