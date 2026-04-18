/** @openapi { "summary": "Change password", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "oldPassword": { "type": "string" }, "newPassword": { "type": "string" } }, "required": ["oldPassword","newPassword"] } } } }, "responses": { "200": { "description": "Password changed" }, "400": { "description": "Invalid password" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    const payload = await AuthService.changePassword(
      req.body.oldPassword,
      req.body.newPassword,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
