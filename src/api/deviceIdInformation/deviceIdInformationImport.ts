/** @openapi { "summary": "Import device id information (bulk)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "array", "items": { "type": "object", "properties": { "deviceId": { "type": "string" } } } }, "importHash": { "type": "string" } }, "required": ["importHash"] } } } }, "responses": { "200": { "description": "Import accepted" }, "400": { "description": "Import error or duplicate" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import DeviceIdInformationService from '../../services/deviceIdInformationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.deviceIdInformationImport,
    );

    await new DeviceIdInformationService(req).import(
      req.body.data,
      req.body.importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
