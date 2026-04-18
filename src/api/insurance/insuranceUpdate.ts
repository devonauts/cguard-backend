/** @openapi { "summary": "Update insurance record", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "insurer": { "type": "string" }, "policyNumber": { "type": "string" }, "coverage": { "type": "string" }, "premium": { "type": "number" }, "startDate": { "type": "string", "format": "date-time" }, "endDate": { "type": "string", "format": "date-time" }, "contactName": { "type": "string" }, "contactPhone": { "type": "string" }, "contactEmail": { "type": "string", "format": "email" }, "attachment": { "type": "array", "items": { "type": "object" } } } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InsuranceService from '../../services/insuranceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.insuranceEdit,
    );

    const payload = await new InsuranceService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
