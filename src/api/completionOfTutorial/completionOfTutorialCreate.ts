/** @openapi { "summary": "Create completion of tutorial", "description": "Marks a tutorial as completed for a user.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "userId": { "type": "string" }, "tutorialId": { "type": "string" }, "completedAt": { "type": "string", "format": "date-time" }, "notes": { "type": "string" }, "importHash": { "type": "string" } }, "required": ["userId","tutorialId"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CompletionOfTutorialService from '../../services/completionOfTutorialService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.completionOfTutorialCreate,
    );

    const payload = await new CompletionOfTutorialService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
