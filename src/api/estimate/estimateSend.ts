/** @openapi { "summary": "Send an estimate via email (generates PDF and sends)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": {} } } } }, "responses": { "200": { "description": "Sent result with email status" }, "400": { "description": "Send error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import EstimateService from '../../services/estimateService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateSend,
    );

    const { id } = req.params;

    const payload = await new EstimateService(req).send(
      id,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
