/** @openapi { "summary": "Create shift", "description": "Create a shift record (assign guard to post/site/station).", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "postSite": { "type": "string" }, "tenantUserId": { "type": "string" }, "tenant_user_id": { "type": "string" }, "guard": { "type": "string" }, "guardId": { "type": "string" }, "station": { "type": "string" }, "siteTours": { "type": "array", "items": { "type": "object" } }, "tasks": { "type": "array", "items": { "type": "object" } }, "postOrders": { "type": "array", "items": { "type": "object" } }, "checklists": { "type": "array", "items": { "type": "object" } }, "skillSet": { "type": "array", "items": { "type": "string" } }, "startAt": { "type": "string", "format": "date-time" }, "endAt": { "type": "string", "format": "date-time" } }, "required": ["postSite","tenantUserId"] } } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftService from '../../services/shiftService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.shiftCreate,
    );

    const payload = await new ShiftService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
