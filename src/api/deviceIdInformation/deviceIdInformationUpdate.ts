/** @openapi { "summary": "Update device id information", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "deviceId": { "type": "string" }, "importHash": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import DeviceIdInformationService from '../../services/deviceIdInformationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.deviceIdInformationEdit,
    );

    const payload = await new DeviceIdInformationService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
