/** @openapi { "summary": "Create insurance record", "description": "Create an insurance/policy record for a tenant.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "insurer": { "type": "string" }, "policyNumber": { "type": "string" }, "coverage": { "type": "string" }, "premium": { "type": "number" }, "startDate": { "type": "string", "format": "date-time" }, "endDate": { "type": "string", "format": "date-time" }, "contactName": { "type": "string" }, "contactPhone": { "type": "string" }, "contactEmail": { "type": "string", "format": "email" }, "attachment": { "type": "array", "items": { "type": "object" } } }, "required": ["insurer","policyNumber"] } } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InsuranceService from '../../services/insuranceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.insuranceCreate,
    );

    const payload = await new InsuranceService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
