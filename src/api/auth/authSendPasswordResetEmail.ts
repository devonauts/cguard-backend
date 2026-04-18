/** @openapi { "summary": "Send password reset email", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email"] } } } }, "responses": { "200": { "description": "Email sent" }, "404": { "description": "Email not found" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    await AuthService.sendPasswordResetEmail(
      req.language,
      req.body.email,
      req.body.tenantId,
      req,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
