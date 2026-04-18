/** @openapi { "summary": "Import insurance records", "description": "Import multiple insurance records via JSON array.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "insurer": { "type": "string" }, "policyNumber": { "type": "string" }, "coverage": { "type": "string" }, "premium": { "type": "number" }, "startDate": { "type": "string", "format": "date-time" }, "endDate": { "type": "string", "format": "date-time" } } } }, "importHash": { "type": "string" } } } } } }, "responses": { "200": { "description": "Import result" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InsuranceService from '../../services/insuranceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.insuranceImport,
    );

    await new InsuranceService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
