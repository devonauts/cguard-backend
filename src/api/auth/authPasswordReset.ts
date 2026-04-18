/** @openapi { "summary": "Reset password using token", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "token": { "type": "string" }, "password": { "type": "string" } }, "required": ["token","password"] } } } }, "responses": { "200": { "description": "Password reset" }, "400": { "description": "Invalid token" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    const payload = await AuthService.passwordReset(
      req.body.token,
      req.body.password,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
