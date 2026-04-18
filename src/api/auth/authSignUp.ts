/** @openapi { "summary": "Sign up", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "User created" }, "400": { "description": "Validation error" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    console.log('🔵 Signup request received:');
    console.log('📧 Email:', req.body.email);
    console.log('🔐 Password provided:', !!req.body.password);
    console.log('🎫 Invitation token:', req.body.invitationToken);
    console.log('🏢 Tenant ID:', req.body.tenantId);

    const payload = await AuthService.signup(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    );

    console.log('✅ Signup successful!');
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    console.log('❌ Signup error:', (error as Error).message);
    console.log('📊 Error stack:', (error as Error).stack);
    await ApiResponseHandler.error(req, res, error);
  }
};
