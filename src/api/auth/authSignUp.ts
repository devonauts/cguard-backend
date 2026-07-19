/** @openapi { "summary": "Sign up", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "User created" }, "400": { "description": "Validation error" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    const payload = await AuthService.signup(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    console.warn('Signup error:', (error as Error).message);
    await ApiResponseHandler.error(req, res, error);
  }
};
