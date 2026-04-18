/** @openapi { "summary": "Convert an estimate into an invoice", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": {} } } } }, "responses": { "200": { "description": "Invoice created from estimate" }, "400": { "description": "Conversion error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import EstimateService from '../../services/estimateService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateConvert,
    );

    const { id } = req.params;

    const payload = await new EstimateService(req).convert(
      id,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
